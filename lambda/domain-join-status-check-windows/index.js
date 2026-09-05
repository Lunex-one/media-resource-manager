// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient();

// SSM's own words for a command invocation that has not finished. `Pending` and `Delayed` are
// invocations that have not started running yet, and every one of them used to fall through to the
// failure branch below, which reported a domain join as failed before it had begun.
const NOT_FINISHED = ['Pending', 'InProgress', 'Delayed'];

exports.handler = async (event) => {
    console.log('Checking domain join status:', JSON.stringify(event, null, 2));

    const { instanceId, domainJoinCommandId } = event;

    try {
        const result = await ssm.send(new GetCommandInvocationCommand({
            CommandId: domainJoinCommandId,
            InstanceId: instanceId
        }));

        const status = result.Status;
        console.log('Domain join command status: ' + status);

        if (status === 'Success') {
            console.log('Domain join completed successfully');
            return {
                ...event,
                domainJoinComplete: true,
                domainJoinInProgress: false,
                domainJoinStatus: status
            };
        } else if (NOT_FINISHED.includes(status)) {
            console.log('Domain join still in progress');
            return {
                ...event,
                domainJoinComplete: false,
                domainJoinInProgress: true,
                domainJoinStatus: status
            };
        } else {
            // Cancelled, TimedOut, Failed, Cancelling: over, and not successfully. Saying so is what
            // lets the state machine fail the build now instead of polling a dead command until its
            // own hour runs out - which on a GPU workstation is most of an hour of billing spent
            // waiting for an answer that had already arrived.
            console.log('Domain join failed with status: ' + status);
            console.log('Command output:', result.StandardOutputContent);
            console.log('Command error:', result.StandardErrorContent);
            return {
                ...event,
                domainJoinComplete: false,
                domainJoinInProgress: false,
                domainJoinStatus: status,
                error: 'Domain join failed: ' + status
            };
        }
    } catch (error) {
        console.error('Error checking domain join status:', error);
        // The command has not been registered against the instance yet. SSM throws this for the
        // first few seconds after SendCommand returns, so it means "ask again", not "it failed" -
        // which is how every other status check in this repo reads it. Reading it as a failure
        // stranded a workstation on 5 September 2026: the check returned `domainJoinComplete:
        // false` for a join that had not begun, the state machine took its default branch, and the
        // build ended reporting success over a machine still joining the domain.
        if (error.name === 'InvocationDoesNotExist') {
            console.log('Command invocation not found yet, treating as in progress');
            return {
                ...event,
                domainJoinComplete: false,
                domainJoinInProgress: true,
                domainJoinStatus: 'Pending'
            };
        }
        // Anything else - SSM unreachable, throttling, a permissions change - is this function
        // failing rather than the domain join failing, and the two must not be reported the same
        // way. `domainJoinInProgress: true` keeps the poll going so a transient fault costs a pass
        // rather than a machine; the state machine's own timeout is what bounds it.
        return {
            ...event,
            domainJoinComplete: false,
            domainJoinInProgress: true,
            error: error.message
        };
    }
};
