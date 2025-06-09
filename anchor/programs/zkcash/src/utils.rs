use crate::Proof;
use crate::groth16::{Groth16Verifier, Groth16Verifyingkey};
use ark_bn254;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use std::ops::Neg;
use primitive_types::U256;
use anchor_lang::prelude::*;

type G1 = ark_bn254::g1::G1Affine;

pub const FIELD_SIZE: U256 = U256([
    0x43E1F593F0000001u64, 
    0x2833E84879B97091u64, 
    0xB85045B68181585Du64, 
    0x30644E72E131A029u64,
]);

pub const VERIFYING_KEY: Groth16Verifyingkey =  Groth16Verifyingkey {
	nr_pubinputs: 8,

	vk_alpha_g1: [
		45,77,154,167,227,2,217,223,65,116,157,85,7,148,157,5,219,234,51,251,177,108,100,59,34,245,153,162,190,109,242,226,
		20,190,221,80,60,55,206,176,97,216,236,96,32,159,227,69,206,137,131,10,25,35,3,1,240,118,202,255,0,77,25,38,
	],

	vk_beta_g2: [
		9,103,3,47,203,247,118,209,175,201,133,248,136,119,241,130,211,132,128,166,83,242,222,202,169,121,76,188,59,243,6,12,
		14,24,120,71,173,76,121,131,116,208,214,115,43,245,1,132,125,214,139,192,224,113,36,30,2,19,188,127,193,61,183,171,
		48,76,251,209,224,138,112,74,153,245,232,71,217,63,140,60,170,253,222,196,107,122,13,55,157,166,154,77,17,35,70,167,
		23,57,193,177,164,87,168,199,49,49,35,210,77,47,145,146,248,150,183,198,62,234,5,169,213,127,6,84,122,208,206,200,
	],

	vk_gamme_g2: [
		25,142,147,147,146,13,72,58,114,96,191,183,49,251,93,37,241,170,73,51,53,169,231,18,151,228,133,183,174,243,18,194,
		24,0,222,239,18,31,30,118,66,106,0,102,94,92,68,121,103,67,34,212,247,94,218,221,70,222,189,92,217,146,246,237,
		9,6,137,208,88,95,240,117,236,158,153,173,105,12,51,149,188,75,49,51,112,179,142,243,85,172,218,220,209,34,151,91,
		18,200,94,165,219,140,109,235,74,171,113,128,141,203,64,143,227,209,231,105,12,67,211,123,76,230,204,1,102,250,125,170,
	],

	vk_delta_g2: [
		15,159,39,109,61,94,20,240,202,156,89,204,225,57,37,13,97,132,175,226,119,252,137,210,79,48,156,176,46,147,214,50,
		19,91,231,214,87,68,168,164,134,155,70,234,36,121,68,236,38,19,22,155,18,139,31,69,60,37,27,75,197,136,121,140,
		45,102,62,53,59,137,117,204,77,167,100,43,69,185,241,64,138,56,139,33,247,140,17,160,30,98,243,53,94,89,176,239,
		27,237,89,71,75,28,115,184,67,20,55,223,193,13,46,176,211,64,146,43,221,214,133,85,92,19,209,225,251,82,35,57,
	],

	vk_ic: &[
		[
			17,121,65,54,172,179,3,27,145,76,54,95,193,27,51,212,4,192,173,114,20,148,64,172,232,191,245,242,31,6,180,174,
			42,16,37,172,73,120,98,73,63,120,173,129,102,56,115,198,168,140,252,112,131,242,28,224,184,145,130,124,65,33,168,217,
		],
		[
			6,61,55,210,100,127,2,60,207,55,138,6,42,158,225,17,81,101,230,34,182,78,102,140,107,68,113,247,44,139,120,209,
			28,127,243,6,150,110,91,59,123,79,17,245,75,219,182,13,208,200,175,176,135,160,67,164,127,32,29,157,123,41,2,66,
		],
		[
			40,228,137,109,210,31,216,163,55,120,190,88,159,208,222,84,112,76,27,113,23,28,7,44,104,234,167,35,162,130,168,56,
			38,39,139,214,243,78,68,155,153,172,35,70,194,7,220,97,208,100,96,1,96,13,85,143,19,10,179,199,93,179,242,35,
		],
		[
			37,142,186,189,225,14,239,62,4,227,107,42,18,103,56,42,135,98,137,76,45,72,161,171,112,116,191,116,190,204,11,155,
			27,206,50,89,10,1,223,126,149,42,2,169,192,42,210,177,99,120,98,67,173,97,180,134,34,176,154,221,24,120,48,194,
		],
		[
			24,50,77,144,114,136,173,138,121,1,130,94,123,102,108,210,170,240,141,45,205,242,68,82,123,99,100,237,215,158,217,113,
			22,68,147,219,6,180,252,10,132,157,66,95,174,39,31,117,192,37,215,88,159,136,194,199,52,19,7,147,73,115,121,11,
		],
		[
			30,106,49,137,43,192,130,17,36,105,153,184,101,171,53,197,66,135,145,147,50,20,19,154,158,81,229,94,135,147,141,74,
			13,168,235,215,227,58,0,142,0,215,67,220,11,22,157,5,255,171,44,244,156,59,83,20,192,159,228,236,13,159,11,55,
		],
		[
			24,28,215,82,77,85,65,29,196,90,175,62,177,159,106,218,166,223,109,181,103,187,126,72,24,12,9,113,133,60,27,126,
			9,187,219,107,246,80,62,12,210,244,228,75,195,52,112,92,177,63,246,83,203,233,191,35,183,133,94,196,40,202,190,27,
		],
		[
			43,72,4,237,7,148,49,104,153,98,178,118,45,152,74,217,103,148,222,98,19,183,73,106,180,21,148,80,33,157,21,169,
			44,205,154,226,11,53,235,106,163,112,185,130,212,183,21,251,159,113,61,230,254,111,27,243,123,153,218,23,169,3,187,103,
		],
	]
};

/**
 * Calculates the expected public amount from ext_amount and fee, then verifies if it matches
 * the provided public_amount_bytes.
 *
 * @param ext_amount The external amount (can be positive or negative), as i64.
 * @param fee The fee (non-negative), as u64.
 * @param public_amount_bytes The public amount to verify against, as a 32-byte array (big-endian).
 * @return Returns `true` if the calculated public amount matches public_amount_bytes AND 
 *         the input ext_amount and fee are valid according to predefined limits. 
 *         Returns `false` otherwise (either due to mismatch or invalid inputs for calculation).
 */
pub fn check_public_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> bool {
    if ext_amount == i64::MIN {
        msg!("can't use i64::MIN as ext_amount"); 
        return false;
    }

    let fee_u256 = U256::from(fee);
    let ext_amount_u256 = if ext_amount >= 0 {
        U256::from(ext_amount as u64)
    } else {
        U256::from((-ext_amount) as u64)
    };

    // return false if the deposit amount is barely enough to cover the fee
    if ext_amount >= 0 && ext_amount_u256 <= fee_u256 {
        return false;
    }

    let result_public_amount = if ext_amount >= 0 {
        (ext_amount_u256 - fee_u256) % FIELD_SIZE
    } else {
        (FIELD_SIZE - ext_amount_u256 - fee_u256) % FIELD_SIZE
    };

    let provided_amount = U256::from_big_endian(&public_amount_bytes);

    msg!("FIELD_SIZE: {}", FIELD_SIZE);
    msg!("Calculated public amount: {}", result_public_amount);
    msg!("Provided fee: {}", fee_u256);
    msg!("Provided ext_amount: {}", ext_amount);
    msg!("Provided public amount: {}", provided_amount);

    result_public_amount == provided_amount
}

pub fn verify_proof(proof: Proof, verifying_key: Groth16Verifyingkey) -> bool {
    let mut public_inputs_vec: [[u8; 32]; 7] = [[0u8; 32]; 7];

    public_inputs_vec[0] = proof.root;
    public_inputs_vec[1] = proof.public_amount;
    public_inputs_vec[2] = proof.ext_data_hash;
    public_inputs_vec[3] = proof.input_nullifiers[0];
    public_inputs_vec[4] = proof.input_nullifiers[1];
    public_inputs_vec[5] = proof.output_commitments[0];
    public_inputs_vec[6] = proof.output_commitments[1];

     // First deserialize PROOF_A into a G1 point
     let g1_point = G1::deserialize_with_mode(
        &*[&change_endianness(&proof.proof_a[0..64]), &[0u8][..]].concat(),
        Compress::No,
        Validate::Yes,
    )
    .unwrap();
    
    let mut proof_a_neg = [0u8; 65];
    g1_point
        .neg()
        .x
        .serialize_with_mode(&mut proof_a_neg[..32], Compress::No)
        .unwrap();
    g1_point
        .neg()
        .y
        .serialize_with_mode(&mut proof_a_neg[32..], Compress::No)
        .unwrap();

    let proof_a: [u8; 64] = change_endianness(&proof_a_neg[..64]).try_into().unwrap();

    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof.proof_b,
        &proof.proof_c,
        &public_inputs_vec,
        &verifying_key
    ).unwrap();

    verifier.verify().unwrap_or(false)
}

pub fn change_endianness(bytes: &[u8]) -> Vec<u8> {
    let mut vec = Vec::new();
    for b in bytes.chunks(32) {
        for byte in b.iter().rev() {
            vec.push(*byte);
        }
    }
    vec
}