pragma circom 2.0.0;

include "./transaction.circom";

// Simplified transaction circuit for debugging
// We're ignoring levels, nIns, nOuts, and zeroLeaf since our simplified circuit doesn't use them
// Use 26 as the level, the same as light protocol v1 (supports 33,554,432 transactions).
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(26, 2, 2);
