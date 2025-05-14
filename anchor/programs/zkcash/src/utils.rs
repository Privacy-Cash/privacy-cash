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
		43,41,94,31,175,127,218,205,137,192,84,245,197,233,165,45,145,138,232,57,223,230,142,57,156,142,58,170,63,102,7,62,
		5,183,11,34,22,31,153,46,109,19,29,105,130,87,198,234,189,141,209,12,8,217,77,131,83,99,175,101,16,162,157,217,
		33,70,145,84,134,37,164,117,153,34,133,194,106,202,68,115,36,0,47,220,150,113,7,194,110,17,101,24,131,49,194,183,
		5,76,46,80,121,121,127,57,19,239,24,217,251,67,91,191,72,2,86,112,107,124,157,193,38,190,110,117,91,30,41,49,
	],

	vk_ic: &[
		[
			18,200,58,156,74,196,133,59,22,215,143,27,56,166,23,158,13,94,185,220,230,153,32,24,119,48,116,193,245,144,191,232,
			29,119,182,174,167,97,52,102,28,150,162,57,236,189,71,34,167,151,2,139,57,183,9,166,150,167,43,185,168,229,64,111,
		],
		[
			19,126,207,135,160,132,74,64,33,100,188,207,162,26,172,210,97,64,212,231,93,0,97,124,206,97,189,227,46,132,210,58,
			16,128,64,251,210,34,0,173,90,211,205,244,48,146,22,163,34,73,254,162,184,231,166,238,18,10,6,187,2,80,174,215,
		],
		[
			36,30,51,91,182,12,199,1,80,197,226,134,209,74,153,133,120,144,230,147,151,141,157,73,41,113,248,112,136,88,147,202,
			47,12,44,1,94,40,246,32,37,111,196,46,208,176,35,83,201,32,50,215,216,103,33,168,89,233,201,242,34,143,163,48,
		],
		[
			7,249,127,20,35,230,219,181,124,5,209,238,30,168,123,107,19,91,157,8,3,182,14,141,66,30,40,241,142,109,196,162,
			40,176,55,220,255,107,145,143,147,57,250,66,64,199,5,93,63,138,218,8,193,245,154,59,145,228,157,35,162,212,60,181,
		],
		[
			28,246,215,39,109,149,76,106,86,217,110,194,196,180,110,121,238,51,2,57,54,139,10,7,141,0,33,249,209,24,56,43,
			21,74,67,95,253,228,65,212,17,132,151,47,94,84,123,106,38,147,189,236,82,101,205,161,92,110,141,233,23,87,49,144,
		],
		[
			33,149,94,239,163,232,188,151,201,161,226,116,239,247,158,118,161,134,223,247,137,202,109,215,95,138,125,158,137,25,122,111,
			8,36,239,92,63,28,128,38,35,32,113,240,76,73,126,150,30,78,253,77,138,96,60,239,163,202,133,242,149,176,18,210,
		],
		[
			42,219,130,61,145,153,132,109,101,18,69,220,89,190,2,121,34,71,146,138,163,243,77,128,85,76,237,156,25,29,229,145,
			25,170,233,58,203,89,195,32,7,82,124,176,152,97,42,80,128,108,102,177,26,221,201,29,252,7,119,40,143,14,128,29,
		],
		[
			27,20,41,164,188,237,30,155,92,45,77,135,54,41,56,157,182,102,189,134,100,78,253,15,41,185,31,128,62,2,48,205,
			19,45,126,103,113,119,3,250,178,8,47,40,193,190,239,215,234,153,241,45,79,235,151,170,38,32,197,42,118,239,23,107,
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