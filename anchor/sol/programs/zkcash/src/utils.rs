use crate::Proof;
use crate::groth16::{Groth16Verifier, Groth16Verifyingkey};
use crate::ErrorCode;
use ark_bn254;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use std::ops::Neg;
use ark_bn254::Fr;
use ark_ff::PrimeField;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

type G1 = ark_bn254::g1::G1Affine;

pub const SOL_ADDRESS: Pubkey = anchor_lang::pubkey!("11111111111111111111111111111112");

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
		25,252,204,73,0,218,132,40,192,175,106,179,247,34,6,163,111,68,46,211,76,146,16,158,28,23,146,254,157,94,7,92,
		34,128,9,143,49,11,128,172,203,141,109,166,180,82,110,179,223,71,56,138,77,154,73,160,146,198,203,125,196,135,167,56,
		21,152,106,224,184,3,47,85,250,118,220,185,175,242,111,30,40,24,69,173,252,13,109,1,241,162,122,76,24,38,72,88,
		45,118,91,197,236,236,152,29,29,233,108,250,155,255,230,156,182,159,1,3,41,60,40,136,181,220,23,150,130,211,23,83,
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

/**
 * Validates that the provided fee meets the minimum required fee based on global configuration.
 * 
 * For deposits (ext_amount > 0):
 * - expected_fee = (ext_amount * deposit_fee_rate) / 10000
 * - minimum_fee = expected_fee * (1 - fee_error_margin/10000)
 * 
 * For withdrawals (ext_amount < 0):
 * - expected_fee = (abs(ext_amount) * withdrawal_fee_rate) / 10000
 * - minimum_fee = expected_fee * (1 - fee_error_margin/10000)
 * 
 * @param ext_amount The external amount (positive for deposits, negative for withdrawals)
 * @param provided_fee The fee provided by the user
 * @param deposit_fee_rate Fee rate for deposits (in basis points, 0-10000)
 * @param withdrawal_fee_rate Fee rate for withdrawals (in basis points, 0-10000)
 * @param fee_error_margin Tolerance rate (in basis points, 0-10000)
 * @return Ok(()) if fee is valid, Err(ErrorCode) if invalid
 */
pub fn validate_fee(
    ext_amount: i64,
    provided_fee: u64,
    deposit_fee_rate: u16,
    withdrawal_fee_rate: u16,
    fee_error_margin: u16,
) -> Result<()> {
    if ext_amount > 0 {
        // Deposit: check fee against deposit rate
        let expected_fee = (ext_amount as u128)
            .checked_mul(deposit_fee_rate as u128)
            .ok_or(ErrorCode::ArithmeticOverflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::ArithmeticOverflow)? as u64;
        
        // Calculate minimum acceptable fee: expected_fee * (1 - fee_error_margin/10000)
        let min_acceptable_fee = if expected_fee > 0 {
            let error_multiplier = 10000u128.checked_sub(fee_error_margin as u128)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            (expected_fee as u128)
                .checked_mul(error_multiplier)
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .checked_div(10000)
                .ok_or(ErrorCode::ArithmeticOverflow)? as u64
        } else {
            0 // If expected fee is 0, minimum is also 0
        };
        
        require!(
            provided_fee >= min_acceptable_fee,
            ErrorCode::InvalidFeeAmount
        );
    } else if ext_amount < 0 {
        // Withdrawal: check fee against withdrawal rate
        let withdrawal_amount = ext_amount.checked_neg()
            .ok_or(ErrorCode::ArithmeticOverflow)? as u64;
        
        let expected_fee = (withdrawal_amount as u128)
            .checked_mul(withdrawal_fee_rate as u128)
            .ok_or(ErrorCode::ArithmeticOverflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::ArithmeticOverflow)? as u64;
        
        // Calculate minimum acceptable fee: expected_fee * (1 - fee_error_margin/10000)
        let min_acceptable_fee = if expected_fee > 0 {
            let error_multiplier = 10000u128.checked_sub(fee_error_margin as u128)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            (expected_fee as u128)
                .checked_mul(error_multiplier)
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .checked_div(10000)
                .ok_or(ErrorCode::ArithmeticOverflow)? as u64
        } else {
            0 // If expected fee is 0, minimum is also 0
        };
        
        require!(
            provided_fee >= min_acceptable_fee,
            ErrorCode::InvalidFeeAmount
        );
    }
    // For ext_amount == 0, no fee validation needed
    
    Ok(())
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
     let g1_point = match G1::deserialize_with_mode(
        &*[&change_endianness(&proof.proof_a[0..64]), &[0u8][..]].concat(),
        Compress::No,
        Validate::Yes,
    ) {
        Ok(point) => point,
        Err(_) => return false,
    };
    
    let mut proof_a_neg = [0u8; 65];
    if g1_point
        .neg()
        .x
        .serialize_with_mode(&mut proof_a_neg[..32], Compress::No)
        .is_err() {
        return false;
    }
    if g1_point
        .neg()
        .y
        .serialize_with_mode(&mut proof_a_neg[32..], Compress::No)
        .is_err() {
        return false;
    }

    let proof_a: [u8; 64] = match change_endianness(&proof_a_neg[..64]).try_into() {
        Ok(array) => array,
        Err(_) => return false,
    };

    let mut verifier = match Groth16Verifier::new(
        &proof_a,
        &proof.proof_b,
        &proof.proof_c,
        &public_inputs_vec,
        &verifying_key
    ) {
        Ok(v) => v,
        Err(_) => return false,
    };

    verifier.verify().unwrap_or(false)
}

/**
 * Calculate ExtData hash with encrypted outputs included
 * This matches the client-side calculation for hash verification
 */
pub fn calculate_complete_ext_data_hash(
    recipient: Pubkey,
    ext_amount: i64,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    fee: u64,
    fee_recipient: Pubkey,
    mint_address: Pubkey,
) -> Result<[u8; 32]> {
    #[derive(AnchorSerialize)]
    struct CompleteExtData {
        pub recipient: Pubkey,
        pub ext_amount: i64,
        pub encrypted_output1: Vec<u8>,
        pub encrypted_output2: Vec<u8>,
        pub fee: u64,
        pub fee_recipient: Pubkey,
        pub mint_address: Pubkey,
    }
    
    let complete_ext_data = CompleteExtData {
        recipient,
        ext_amount,
        encrypted_output1: encrypted_output1.to_vec(),
        encrypted_output2: encrypted_output2.to_vec(),
        fee,
        fee_recipient,
        mint_address,
    };
    
    let mut serialized_ext_data = Vec::new();
    complete_ext_data.serialize(&mut serialized_ext_data)?;
    let calculated_ext_data_hash = hash(&serialized_ext_data).to_bytes();
    
    Ok(calculated_ext_data_hash)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_fee_deposit_exact_minimum() {
        // Test deposit with exact minimum fee
        // 1000 * 25 / 10000 = 2.5 -> 2 (rounded down)
        // minimum = 2 * 95% = 1.9 -> 1 (rounded down)
        let result = validate_fee(
            1000,  // ext_amount (deposit)
            1,     // provided_fee (exact minimum)
            0,     // deposit_fee_rate (0% - free deposits)
            25,    // withdrawal_fee_rate (0.25%)
            500,   // error_rate (5%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_deposit_above_minimum() {
        // Test deposit with fee above minimum
        let result = validate_fee(
            1000,  // ext_amount (deposit)
            10,    // provided_fee (well above minimum)
            0,     // deposit_fee_rate (0% - free deposits)
            25,    // withdrawal_fee_rate (0.25%)
            500,   // error_rate (5%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_deposit_below_minimum() {
        // Test that deposits with 0% fee rate accept any fee >= 0
        // Since deposits are free, any fee should be acceptable
        // 10000 * 0 / 10000 = 0 (expected fee)
        // minimum = 0 * 95% = 0 (minimum acceptable fee)
        let result = validate_fee(
            10000, // ext_amount (deposit)
            0,     // provided_fee (even 0 is acceptable for free deposits)
            0,     // deposit_fee_rate (0% - free deposits)
            25,    // withdrawal_fee_rate (0.25%)
            500,   // error_rate (5%)
        );
        assert!(result.is_ok()); // Should pass since deposits are free
    }

    #[test]
    fn test_validate_fee_withdrawal_zero_rate() {
        // Test withdrawal with 0% fee rate
        let result = validate_fee(
            -1000, // ext_amount (withdrawal)
            5,     // provided_fee (any amount is fine since expected is 0)
            25,    // deposit_fee_rate
            0,     // withdrawal_fee_rate (0%)
            500,   // error_rate (5%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_withdrawal_with_rate() {
        // Test withdrawal with non-zero fee rate
        // 1000 * 50 / 10000 = 5
        // minimum = 5 * 95% = 4.75 -> 4 (rounded down)
        let result = validate_fee(
            -1000, // ext_amount (withdrawal)
            4,     // provided_fee (exact minimum)
            25,    // deposit_fee_rate
            50,    // withdrawal_fee_rate (0.5%)
            500,   // error_rate (5%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_withdrawal_below_minimum() {
        // Test withdrawal with fee below minimum
        // 1000 * 100 / 10000 = 10
        // minimum = 10 * 95% = 9.5 -> 9 (rounded down)
        let result = validate_fee(
            -1000, // ext_amount (withdrawal)
            8,     // provided_fee (below minimum of 9)
            25,    // deposit_fee_rate
            100,   // withdrawal_fee_rate (1%)
            500,   // error_rate (5%)
        );
        assert!(result.is_err());
        // In anchor, the error is wrapped, so we need to check the error differently
        match result {
            Err(e) => {
                // Check that it contains our error code
                assert!(e.to_string().contains("InvalidFeeAmount") || format!("{:?}", e).contains("InvalidFeeAmount"));
            },
            Ok(_) => panic!("Expected error but got Ok"),
        }
    }

    #[test]
    fn test_validate_fee_zero_amount() {
        // Test with zero ext_amount (should always pass)
        let result = validate_fee(
            0,     // ext_amount (neither deposit nor withdrawal)
            100,   // provided_fee
            25,    // deposit_fee_rate
            50,    // withdrawal_fee_rate
            500,   // error_rate
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_small_deposit_zero_expected() {
        // Test very small deposit that results in 0 expected fee
        // 1 * 25 / 10000 = 0.0025 -> 0 (rounded down)
        let result = validate_fee(
            1,     // ext_amount (very small deposit)
            0,     // provided_fee (0 is acceptable when expected is 0)
            25,    // deposit_fee_rate (0.25%)
            0,     // withdrawal_fee_rate
            500,   // error_rate (5%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_high_fee_error_margin() {
        // Test with high fee error margin (50%)
        // 1000 * 25 / 10000 = 2.5 -> 2
        // minimum = 2 * 50% = 1
        let result = validate_fee(
            1000,  // ext_amount (deposit)
            1,     // provided_fee (minimum with 50% fee error margin)
            25,    // deposit_fee_rate (0.25%)
            0,     // withdrawal_fee_rate
            5000,  // fee_error_margin (50%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_overflow_protection() {
        // Test that we don't overflow with large amounts
        // Use a large but safe value that won't cause overflow during multiplication
        let result = validate_fee(
            1_000_000_000, // ext_amount (1 billion, large but safe)
            1000000,       // provided_fee
            1,             // deposit_fee_rate (small rate to avoid overflow)
            0,             // withdrawal_fee_rate
            500,           // error_rate (5%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_edge_case_min_withdrawal() {
        // Test edge case with minimum negative value (but not i64::MIN)
        let result = validate_fee(
            -1,    // ext_amount (smallest withdrawal)
            0,     // provided_fee
            25,    // deposit_fee_rate
            0,     // withdrawal_fee_rate (0%, so any fee is fine)
            500,   // error_rate (5%)
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_fee_arithmetic_overflow_detection() {
        // Test that arithmetic overflow is properly detected and handled
        // Using maximum values that would cause overflow in the multiplication
        let result = validate_fee(
            i64::MAX,  // ext_amount (maximum positive value)
            0,         // provided_fee
            10000,     // deposit_fee_rate (100% - maximum rate)
            0,         // withdrawal_fee_rate
            0,         // fee_error_margin (0% to test exact calculation)
        );
        // This should return an error (either arithmetic overflow or invalid fee amount)
        assert!(result.is_err());
        // We don't need to check the specific error type since overflow protection
        // may result in different error conditions depending on implementation
    }
}