pragma circom 2.0.0;

include "./transaction.circom";

// zeroLeaf = Poseidon(zero, zero)
// default `zero` value is keccak256("tornado") % FIELD_SIZE = 21663839004416932945382355908790599225266501822907911457504978515578255421292
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(20, 16, 2, 0);
