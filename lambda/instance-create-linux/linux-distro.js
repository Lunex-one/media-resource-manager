// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which Linux distribution a text says an image is, in the exact vocabulary that reads the answer.
 *
 * The four words matter and are not ours to choose. `lambda/dcv-session-manager/index.py` matches
 * `linuxDistro` against 'rocky', 'rhel' and 'centos' - all three meaning a DCV session belongs to
 * the `rocky` user - and against 'ubuntu', and it treats any other value exactly as it treats an
 * absent one. So this returns one of those four or null, and never a word of its own invention.
 *
 * `null` is an honest answer rather than a failure: the caller then leaves the attribute off the
 * record, and the reader falls back to the workstation name and the AMI just as it did before
 * anything wrote this field at all.
 *
 * The words are tried in a fixed order, so one text naming two of them resolves to whichever comes
 * first here. That order is only a tie-break inside a single body of evidence and must not be
 * allowed to decide between *sources* - which is what `distroFromAmiOrImageName` is for.
 */
function detectLinuxDistro(...texts) {
    const haystack = texts.filter(Boolean).join(' ').toLowerCase();
    if (haystack.includes('rocky')) return 'rocky';
    if (haystack.includes('rhel') || haystack.includes('red hat')) return 'rhel';
    if (haystack.includes('centos')) return 'centos';
    if (haystack.includes('ubuntu')) return 'ubuntu';
    return null;
}

/**
 * The distribution of a machine about to be built, from the best evidence available at build time.
 *
 * The AMI's own name and description are asked as a group of their own, and `imageName` only if
 * they could not tell. The AMI's fields describe what is actually installed; `imageName` is a label
 * a person typed for a catalogue row or a pipeline, so it can say nothing about the distribution,
 * or the wrong thing. It is still worth asking, because a replicated regional copy does not always
 * carry the source AMI's name into the region being described.
 *
 * Two calls and not one. `detectLinuxDistro` tries its four words in a fixed order, so handing it
 * every text at once would answer 'rocky' for a catalogue row named `rocky-9-render` pointing at an
 * Ubuntu AMI: the word order would decide which source wins, rather than the caller's own reading
 * of which evidence is better. This function is that reading, written where it can be tested.
 */
function distroFromAmiOrImageName(amiName, amiDescription, imageName) {
    return detectLinuxDistro(amiName, amiDescription) || detectLinuxDistro(imageName);
}

/**
 * Both are exported so the precedence rule above is reachable from a test, and both live outside
 * `index.js` for the same reason: that module loads four AWS SDK clients at require time, none of
 * which this repository's root package installs - they arrive with the Lambda runtime - so a test
 * requiring it would fail before reaching any function in it.
 *
 * `lib/workstation-creation-stack-linux.ts` packages this lambda with `Code.fromAsset` over the
 * whole directory, so a sibling file ships with it and needs no build step.
 */
module.exports = { detectLinuxDistro, distroFromAmiOrImageName };
