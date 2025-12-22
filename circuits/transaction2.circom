pragma circom 2.0.0;

include "./transaction.circom";

// Simplified transaction circuit for debugging
// We're ignoring levels, nIns, nOuts, and zeroLeaf since our simplified circuit doesn't use them
// Use 30 as the level (supports 536,870,912 transactions).
component main {public [root, publicAmount, extDataHash, mintAddress, inputNullifier, outputCommitment]} = Transaction(30, 2, 2);
