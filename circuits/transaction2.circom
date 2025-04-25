include "./transaction.circom"

// Simplified transaction circuit for debugging
// We're ignoring levels, nIns, nOuts, and zeroLeaf since our simplified circuit doesn't use them
component main = Transaction(20, 2, 2, 11850551329423159860688778991827824730037759162201783566284850822760196767874);
