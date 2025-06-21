use crate::Proof;
use crate::groth16::{Groth16Verifier, Groth16Verifyingkey};
use ark_bn254;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use std::ops::Neg;
use ark_bn254::Fr;
use ark_ff::PrimeField;
use anchor_lang::prelude::*;

type G1 = ark_bn254::g1::G1Affine;

pub const VERIFYING_KEY: Groth16Verifyingkey =  Groth16Verifyingkey {
	nr_pubinputs: 7,

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
		27,25,0,183,209,6,212,163,117,141,194,130,131,115,191,254,1,117,187,210,21,189,135,144,170,82,240,234,203,153,37,16,
		14,25,34,237,244,218,140,18,63,151,165,134,178,195,68,249,179,206,0,179,250,114,233,231,59,65,207,9,85,82,176,237,
		21,244,120,106,101,252,81,50,86,88,82,19,104,146,221,104,104,12,14,203,187,19,27,69,227,85,231,141,218,98,14,191,
		43,144,45,92,165,199,53,115,243,40,0,138,66,253,101,26,23,38,89,56,198,252,137,24,147,58,92,74,127,64,28,10,
	],

	vk_ic: &[
		[
			35,121,23,162,32,101,247,115,177,199,50,158,3,60,188,95,91,29,121,210,53,155,245,226,203,245,186,167,39,32,160,202,
			22,22,168,160,125,45,56,45,132,214,20,198,76,81,2,150,0,61,86,130,105,170,141,244,13,180,81,79,18,166,129,129,
		],
		[
			13,148,63,234,185,42,3,159,127,24,240,200,72,24,176,7,181,215,212,52,13,160,172,182,177,22,235,4,173,229,25,108,
			46,61,233,184,181,152,132,103,252,100,229,144,217,36,39,254,67,237,70,214,192,231,140,86,113,40,11,88,12,150,157,226,
		],
		[
			26,105,150,204,178,202,26,62,39,178,179,225,133,140,138,40,60,187,99,57,237,7,203,159,251,103,46,207,219,186,19,64,
			0,42,73,5,76,48,115,80,96,29,197,213,228,240,7,144,140,3,127,89,87,247,98,153,174,81,7,158,183,80,139,147,
		],
		[
			6,249,88,104,56,74,144,136,129,176,70,216,18,147,78,141,24,93,95,242,68,49,215,152,246,110,151,241,228,59,230,187,
			29,56,186,210,200,190,93,64,110,0,55,105,166,104,208,46,82,81,146,136,179,99,104,232,99,248,162,137,21,217,220,77,
		],
		[
			34,163,170,91,254,215,220,175,71,67,56,43,178,48,92,7,170,124,201,232,207,202,134,80,123,31,26,236,76,175,186,155,
			46,253,236,170,12,248,30,127,51,136,100,51,34,7,218,21,133,51,148,235,92,210,117,134,121,78,166,90,10,194,193,148,
		],
		[
			36,180,82,206,231,195,86,41,106,145,21,107,234,233,139,225,54,131,165,186,77,127,180,146,240,188,64,37,52,96,13,163,
			24,163,180,194,36,190,184,250,134,211,189,81,228,125,4,21,20,20,255,26,142,105,230,174,244,121,184,65,9,40,77,148,
		],
		[
			11,24,12,201,201,217,179,163,6,167,37,40,172,236,81,246,31,38,112,17,100,163,111,57,31,198,231,63,224,178,38,76,
			12,154,160,41,58,177,5,197,223,113,12,75,237,239,9,40,178,44,222,130,125,221,142,241,213,58,131,242,120,108,213,163,
		],
		[
			1,83,134,187,30,49,61,118,206,110,225,192,155,101,155,204,202,49,229,41,148,232,24,47,85,47,108,99,113,12,209,88,
			41,144,185,30,176,46,190,244,148,151,142,64,45,22,16,17,48,122,183,81,187,18,142,10,230,78,6,42,245,140,166,121,
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

    // Convert to field elements for proper BN254 arithmetic
    let fee_fr = Fr::from(fee);
    let ext_amount_fr = if ext_amount >= 0 {
        Fr::from(ext_amount as u64)
    } else {
        let abs_ext_amount = match ext_amount.checked_neg() {
            Some(val) => val,
            None => return false,
        };
        Fr::from(abs_ext_amount as u64)
    };

    // return false if the deposit amount is barely enough to cover the fee
    if ext_amount >= 0 && ext_amount_fr <= fee_fr {
        return false;
    }

    let result_public_amount = if ext_amount >= 0 {
        // For positive amounts: public_amount = ext_amount - fee
        ext_amount_fr - fee_fr
    } else {
        // For negative amounts: public_amount = -abs(ext_amount) - fee
        // In field arithmetic, this becomes: FIELD_SIZE - (abs(ext_amount) + fee)
        -(ext_amount_fr + fee_fr)
    };

    // Convert provided bytes to field element for comparison
    let provided_amount = Fr::from_be_bytes_mod_order(&public_amount_bytes);
    
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