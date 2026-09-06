# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import boto3
from datetime import datetime

def handler(event, context):
    instance_id = event['instanceId']
    
    # Get DynamoDB client (always in primary region)
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['WORKSTATION_TABLE_NAME'])
    
    try:
        # Get workstation details from DynamoDB to determine platform and region
        workstation = table.get_item(Key={'instanceId': instance_id}).get('Item', {})
        platform = workstation.get('platform', 'windows')  # Default to windows for backward compatibility
        # A record written before joinDomain was persisted on create (or one built by this code's
        # own prior version) carries no such field, and reading that absence as False is what let
        # this reconfigure a domain-joined desktop for local-Administrator auto-login the first
        # time it was ever stopped and started again: joinDomain never reaches a workstation's
        # record without domainId beside it, so a domainId with no joinDomain answer is still a
        # machine that was joined. lambda/fsx-smb-mount-manager/index.js's isDomainJoined reads the
        # same two fields for the same reason.
        join_domain = workstation.get('joinDomain')
        if join_domain is None:
            join_domain = bool(workstation.get('domainId'))
        workstation_region = workstation.get('region', os.environ.get('AWS_REGION'))
        
        print(f"Starting instance {instance_id}, platform: {platform}, joinDomain: {join_domain}, region: {workstation_region}")
        
        # Create EC2 client for the workstation's region
        ec2 = boto3.client('ec2', region_name=workstation_region)
        
        # Start the instance
        ec2.start_instances(InstanceIds=[instance_id])
        print(f"Started instance {instance_id} in region {workstation_region}")
        
        # Update DynamoDB to set dcvStatus to starting and instanceStartTime
        current_time = datetime.utcnow().isoformat() + 'Z'
        table.update_item(
            Key={'instanceId': instance_id},
            UpdateExpression='SET dcvStatus = :status, instanceStartTime = :startTime, updatedAt = :updatedAt',
            ExpressionAttributeValues={
                ':status': 'starting',
                ':startTime': current_time,
                ':updatedAt': current_time
            }
        )
        
        return {
            **event,
            'instanceStarted': True,
            'platform': platform,
            'joinDomain': join_domain,
            'region': workstation_region
        }
    except Exception as e:
        print(f"Error starting instance {instance_id}: {str(e)}")
        return {
            **event,
            'instanceStarted': False,
            'error': str(e)
        }