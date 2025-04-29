include "./transaction.circom"

// Simplified transaction circuit for debugging
// We're ignoring levels, nIns, nOuts, and zeroLeaf since our simplified circuit doesn't use them
component main = Transaction(20, 2, 2, 21663839004416932945382355908790599225266501822907911457504978515578255421292);
