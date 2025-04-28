include "../scripts/node_modules/circomlib/circuits/poseidon.circom";
include "./merkleProof.circom"
include "./keypair.circom"

/*
Utxo structure:
{
    amount,
    pubkey,
    blinding, // random number
}

commitment = hash(amount, pubKey, blinding)
nullifier = hash(commitment, merklePath, sign(privKey, commitment, merklePath))
*/

// Universal JoinSplit transaction with nIns inputs and 2 outputs
template Transaction(levels, nIns, nOuts, zeroLeaf) {
    signal input root;
    // extAmount = external amount used for deposits and withdrawals
    // correct extAmount range is enforced on the smart contract
    // publicAmount = extAmount - fee
    signal input publicAmount;
    signal input extDataHash;

    // data for transaction inputs
    signal         input inputNullifier[nIns];
    signal private input inAmount[nIns];
    signal private input inPrivateKey[nIns];
    signal private input inBlinding[nIns];
    signal private input inPathIndices[nIns];
    // signal private input inPathElements[nIns][levels];

    // // data for transaction outputs
    signal         input outputCommitment[nOuts];
    signal private input outAmount[nOuts];
    // signal private input outPubkey[nOuts];
    // signal private input outBlinding[nOuts];

    // Add back the keypair component
    component inKeypair[nIns];
    // Add back the commitment hasher
    component inCommitmentHasher[nIns];
    component inSignature[nIns];
    component inNullifierHasher[nIns];
    // component inTree[nIns];
    var sumIns = 0;

    for (var tx = 0; tx < nIns; tx++) {
        inKeypair[tx] = Keypair();
        inKeypair[tx].privateKey <== inPrivateKey[tx];

        inCommitmentHasher[tx] = Poseidon(3);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== inKeypair[tx].publicKey;
        inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];

        inSignature[tx] = Signature();
        inSignature[tx].privateKey <== inPrivateKey[tx];
        inSignature[tx].commitment <== inCommitmentHasher[tx].out;
        inSignature[tx].merklePath <== inPathIndices[tx];

        inNullifierHasher[tx] = Poseidon(3);
        inNullifierHasher[tx].inputs[0] <== inCommitmentHasher[tx].out;
        inNullifierHasher[tx].inputs[1] <== inPathIndices[tx];
        inNullifierHasher[tx].inputs[2] <== inSignature[tx].out;
        inNullifierHasher[tx].out === inputNullifier[tx];

    //     inTree[tx] = MerkleProof(levels);
    //     inTree[tx].leaf <== inCommitmentHasher[tx].out;
    //     inTree[tx].pathIndices <== inPathIndices[tx];
    //     for (var i = 0; i < levels; i++) {
    //         inTree[tx].pathElements[i] <== inPathElements[tx][i];
    //     }

    //     inCheckRoot[tx] = ForceEqualIfEnabled();
    //     inCheckRoot[tx].in[0] <== root;
    //     inCheckRoot[tx].in[1] <== inTree[tx].root;
    //     inCheckRoot[tx].enabled <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    // component outCommitmentHasher[nOuts];
    // component outAmountCheck[nOuts];
    var sumOuts = 0;

    // Manually sum the output amounts
    for (var i = 0; i < nOuts; i++) {
        sumOuts += outAmount[i];
    }

    // component sameNullifiers[nIns * (nIns - 1) / 2];
    // var index = 0;
    // for (var i = 0; i < nIns - 1; i++) {
    //   for (var j = i + 1; j < nIns; j++) {
    //       sameNullifiers[index] = IsEqual();
    //       sameNullifiers[index].in[0] <== inputNullifier[i];
    //       sameNullifiers[index].in[1] <== inputNullifier[j];
    //       sameNullifiers[index].out === 0;
    //       index++;
    //   }
    // }

    // sumIns + publicAmount === sumOuts;
    sumIns + publicAmount === sumOuts;

    signal extDataSquare <== extDataHash * extDataHash;
    signal rootSquare <== root * root;
}
