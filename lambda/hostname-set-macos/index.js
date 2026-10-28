// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}

// One DNS label (RFC 1123): letters, digits and hyphens, not starting or ending with a hyphen.
const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * The hostname, refused unless it is one DNS label.
 *
 * It is pasted into the script below, which runs as root or SYSTEM, so anything else - a quote, a
 * `$(...)`, a newline - would be script rather than a name. It is built from the deployment's
 * HostnamePrefix and a counter, so a refusal means that prefix is wrong, or that the name was
 * never generated: before this check a missing one was set as the hostname "null".
 */
function checkedHostname(hostname) {
    if (typeof hostname !== 'string' || !HOSTNAME_LABEL.test(hostname)) {
        throw new Error(`Refusing to set hostname ${JSON.stringify(hostname)}: a hostname is one DNS label of letters, digits and hyphens`);
    }
    return hostname;
}

exports.checkedHostname = checkedHostname;

exports.handler = async (event) => {
    const { instanceId, region } = event;
    const hostname = checkedHostname(event.hostname);
    console.log(`Setting macOS hostname to ${hostname} on instance ${instanceId} (region: ${region || 'primary'})`);

    // macOS uses scutil for hostname management
    // There are three types of hostnames on macOS:
    // - ComputerName: User-friendly name shown in Finder
    // - LocalHostName: Bonjour name (used for .local network discovery)
    // - HostName: UNIX hostname
    const commands = [
        '#!/bin/bash',
        'set -e',
        `HOSTNAME="${hostname}"`,
        'echo "Setting macOS hostname to: $HOSTNAME"',
        '',
        '# Set all three hostname types on macOS',
        'sudo scutil --set ComputerName "$HOSTNAME"',
        'sudo scutil --set LocalHostName "$HOSTNAME"',
        'sudo scutil --set HostName "$HOSTNAME"',
        '',
        '# Flush DNS cache to ensure changes take effect',
        'sudo dscacheutil -flushcache',
        '',
        '# Verify the changes',
        'echo "ComputerName: $(scutil --get ComputerName)"',
        'echo "LocalHostName: $(scutil --get LocalHostName)"',
        'echo "HostName: $(scutil --get HostName)"',
        '',
        'echo "Successfully set all hostname types to $HOSTNAME"'
    ];

    const ssm = getSSMClient(region);
    const result = await ssm.send(new SendCommandCommand({
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [instanceId],
        Parameters: { commands },
        TimeoutSeconds: 120,
        Comment: `Set hostname to ${hostname}`
    }));

    // Update workstation record with hostname
    await dynamodb.send(new UpdateCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId },
        UpdateExpression: 'SET hostname = :hostname, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
            ':hostname': hostname,
            ':updatedAt': new Date().toISOString()
        }
    }));

    return {
        ...event,
        hostnameCommandId: result.Command.CommandId,
        hostnameSet: true
    };
};
