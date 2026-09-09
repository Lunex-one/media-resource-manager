// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

/**
 * How long an execution took, in whole seconds, or undefined while it has not finished.
 *
 * Derived rather than stored. The state machine used to write a `duration` attribute from
 * DescribeTaskExecution's EstimatedFilesToTransfer - a file count in a field the UI renders with
 * formatDuration(seconds) - and no longer writes one at all. The row carries startTime and
 * endTime, so the answer is a subtraction with nothing to keep in step.
 *
 * DescribeTaskExecution does report a real Result.TotalDuration, but only for Enhanced mode
 * tasks. MRM calls CreateTask without a TaskMode, which means Basic mode, and the documented
 * Basic mode response carries PrepareDuration, TransferDuration and VerifyDuration but no
 * TotalDuration. The two timestamps are the only source that is always there.
 *
 * Seconds, because that is what the transfer page's formatDuration takes.
 */
function durationInSeconds(startTime, endTime) {
  if (!startTime || !endTime) return undefined;
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return Math.round((end - start) / 1000);
}

// Maximum number of executions to return
const MAX_EXECUTIONS = 10;

exports.handler = async (event) => {
  console.log('GetDataSyncExecutions event:', JSON.stringify(event, null, 2));
  
  try {
    const taskId = event.pathParameters?.taskId;
    
    if (!taskId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Task ID is required'
        })
      };
    }
    
    // Query execution records for this task
    // Sort key begins with EXECUTION# and we want most recent first
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `TASK#${taskId}`,
        ':skPrefix': 'EXECUTION#'
      },
      ScanIndexForward: false, // Most recent first (descending order)
      Limit: MAX_EXECUTIONS
    }));
    
    console.log('Executions found:', result.Items?.length || 0);
    
    // Map to response format
    const executions = (result.Items || []).map(item => ({
      executionId: item.executionId,
      executionArn: item.executionArn,
      taskId: item.taskId,
      status: item.status,
      startTime: item.startTime,
      endTime: item.endTime,
      bytesTransferred: item.bytesTransferred,
      filesTransferred: item.filesTransferred,
      // bytesVerified and filesVerified used to be projected here and nothing ever wrote
      // either, so both were undefined and JSON.stringify dropped them - they have never
      // appeared in a response, and openapi/overlay.json does not describe them. Removing
      // them changes nothing on the wire and stops the projection promising what it cannot
      // deliver. DescribeTaskExecution has no BytesVerified field at all; it does report
      // FilesVerified, but writing it would mean reading a path that the API omits when
      // VerifyMode is NONE, and an unresolved path fails the state that reads it.
      duration: durationInSeconds(item.startTime, item.endTime),
      errorCode: item.errorCode,
      errorMessage: item.errorMessage
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: executions
      })
    };
  } catch (error) {
    console.error('Error getting DataSync executions:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to retrieve DataSync executions',
        details: error.message
      })
    };
  }
};
