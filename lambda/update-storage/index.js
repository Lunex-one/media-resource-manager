// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'PUT,OPTIONS'
};

exports.handler = async (event) => {
  console.log('UpdateStorage event:', JSON.stringify(event, null, 2));
  
  try {
    const storageId = event.pathParameters?.storageId;
    if (!storageId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Storage ID is required'
        })
      };
    }
    
    const data = JSON.parse(event.body || '{}');
    const updateExpression = [];
    const removeExpression = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    if (data.name) {
      updateExpression.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = data.name;
    }
    
    if (data.status) {
      updateExpression.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = data.status;
    }
    
    // The UI's edit form has always sent this alongside the name; nothing here read it until
    // 2026-08-31, so editing a description silently did nothing. Unlike the fields above, an empty
    // description is a real answer - "this resource has no description" - and create-storage
    // already stores '' for one, so it is set rather than removed.
    if (data.description !== undefined) {
      updateExpression.push('#description = :description');
      expressionAttributeNames['#description'] = 'description';
      expressionAttributeValues[':description'] = data.description;
    }
    
    if (data.configuration) {
      updateExpression.push('#configuration = :configuration');
      expressionAttributeNames['#configuration'] = 'configuration';
      expressionAttributeValues[':configuration'] = data.configuration;
    }
    
    // The three references, under the rule create-storage writes them by: a value sets the
    // attribute, an empty one removes it, so "nobody set this" stays distinguishable from "set to
    // nothing".
    //
    // This changes the record only. The same three reach the real AWS resources as CloudFormation
    // stack tags, and those are fixed when the stack is created - so a reference edited here is
    // right in MRM and stale on the bill for a resource that already exists. Retagging would mean
    // a stack update per storage type, which is not what an edit of a label should trigger.
    for (const field of ['constellationId', 'projectId', 'externalRef']) {
      if (data[field] === undefined) continue;
      if (data[field] === '' || data[field] === null) {
        removeExpression.push(`#${field}`);
        expressionAttributeNames[`#${field}`] = field;
      } else {
        updateExpression.push(`#${field} = :${field}`);
        expressionAttributeNames[`#${field}`] = field;
        expressionAttributeValues[`:${field}`] = data[field];
      }
    }
    
    if (updateExpression.length === 0 && removeExpression.length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'No valid fields to update'
        })
      };
    }
    
    const clauses = [];
    if (updateExpression.length > 0) clauses.push(`SET ${updateExpression.join(', ')}`);
    if (removeExpression.length > 0) clauses.push(`REMOVE ${removeExpression.join(', ')}`);
    
    const updateParams = {
      TableName: process.env.STORAGE_TABLE_NAME,
      Key: { storageId },
      UpdateExpression: clauses.join(' '),
      ExpressionAttributeNames: expressionAttributeNames,
      ReturnValues: 'ALL_NEW'
    };
    // DynamoDB rejects an empty ExpressionAttributeValues, which a request that only clears
    // references would otherwise send.
    if (Object.keys(expressionAttributeValues).length > 0) {
      updateParams.ExpressionAttributeValues = expressionAttributeValues;
    }
    
    const result = await dynamodb.send(new UpdateCommand(updateParams));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: result.Attributes
      })
    };
  } catch (error) {
    console.error('Error updating storage resource:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to update storage resource'
      })
    };
  }
};
