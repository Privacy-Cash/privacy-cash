include "./merkleProof.circom";
include "./merkleTree.circom";

// inserts a subtree into a merkle tree
// checks that tree previously contained zeroes is the same positions
// zeroSubtreeRoot is a root of a subtree that contains only zeroes
template MerkleTreeUpdater(levels, subtreeLevels, zeroSubtreeRoot) {
    var remainingLevels = levels - subtreeLevels;

    signal input oldRoot;
    signal input newRoot;
    signal input leaves[1 << subtreeLevels];
    signal input pathIndices;
    signal private input pathElements[remainingLevels];

    // calculate subtree root
    component subtree = MerkleTree(subtreeLevels);
    for(var i = 0; i < (1 << subtreeLevels); i++) {
        subtree.leaves[i] <== leaves[i];
    }

    component treeBefore = MerkleProof(remainingLevels);
    for(var i = 0; i < remainingLevels; i++) {
        treeBefore.pathElements[i] <== pathElements[i];
    }
    treeBefore.pathIndices <== pathIndices;
    treeBefore.leaf <== zeroSubtreeRoot;
    treeBefore.root === oldRoot;

    component treeAfter = MerkleProof(remainingLevels);
    for(var i = 0; i < remainingLevels; i++) {
        treeAfter.pathElements[i] <== pathElements[i];
    }
    treeAfter.pathIndices <== pathIndices;
    treeAfter.leaf <== subtree.root;
    treeAfter.root === newRoot;
}
