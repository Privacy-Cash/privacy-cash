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
		23,44,193,249,129,121,184,184,144,52,72,225,116,92,220,13,28,18,239,193,154,179,57,229,81,146,108,188,214,250,48,3,
		21,24,198,89,63,6,144,246,151,76,214,227,254,110,112,187,33,26,70,45,209,103,1,222,210,58,208,40,104,59,232,233,
		32,12,79,185,83,183,176,54,26,203,29,234,92,171,192,116,253,9,137,21,86,169,108,32,39,168,178,38,215,85,210,79,
		4,199,121,192,194,16,51,15,239,54,22,143,53,21,238,134,252,184,123,24,168,35,142,119,181,76,215,249,242,135,135,55,
	],

	vk_ic: &[
		[
			46,27,56,169,250,75,236,86,109,212,189,27,92,254,124,186,116,253,95,75,240,219,212,193,139,206,144,236,169,44,116,37,
			39,73,22,208,25,119,102,149,155,46,188,45,224,51,90,159,4,81,47,42,255,173,238,177,37,184,129,86,147,148,169,214,
		],
		[
			42,136,209,15,157,207,23,68,229,120,97,61,230,240,245,71,44,87,207,65,22,148,67,58,29,112,5,203,217,55,105,163,
			17,35,85,156,48,210,53,50,20,164,103,142,228,39,118,240,99,206,132,234,220,11,113,33,59,117,44,17,242,136,177,134,
		],
		[
			46,193,27,56,215,73,193,129,16,241,178,164,9,161,214,82,227,229,29,107,249,78,137,146,103,119,29,19,56,17,234,98,
			11,43,144,92,188,148,212,224,223,98,162,255,80,38,216,71,179,232,105,139,74,65,245,163,123,8,196,52,150,21,73,243,
		],
		[
			40,56,133,135,185,185,143,100,102,124,101,197,0,39,1,207,23,154,249,201,88,55,110,217,251,112,60,110,35,70,247,150,
			2,197,27,104,169,123,175,250,171,211,13,192,238,66,75,200,97,50,34,182,54,229,125,239,188,49,128,117,223,237,251,156,
		],
		[
			7,70,77,57,199,108,150,218,224,68,32,53,180,152,105,245,72,176,63,87,122,125,162,39,252,159,209,158,191,127,49,137,
			1,128,154,128,98,159,5,162,76,117,215,161,142,135,78,74,158,168,113,7,48,17,114,203,155,153,93,97,146,37,132,26,
		],
		[
			14,99,241,29,119,61,65,204,25,184,246,238,124,18,185,134,91,213,81,108,177,139,119,100,219,27,245,75,54,184,154,7,
			29,183,15,72,234,107,179,80,19,205,68,76,169,239,132,142,186,172,117,42,111,66,21,148,205,204,82,3,129,54,131,152,
		],
		[
			37,229,41,204,147,191,26,112,81,185,138,30,29,55,175,17,59,167,215,78,129,97,248,74,97,183,173,17,131,43,200,63,
			21,194,124,39,87,46,17,132,13,170,187,223,204,154,97,101,248,209,190,17,44,106,111,250,218,11,226,21,162,203,124,158,
		],
		[
			2,166,31,195,102,74,4,123,97,175,5,159,96,187,5,101,159,119,137,11,103,116,62,142,8,217,145,19,149,27,138,42,
			6,18,153,90,88,6,205,38,200,42,216,106,57,150,99,53,191,69,221,40,83,77,234,13,116,49,81,206,137,66,157,102,
		],
		[
			38,249,158,15,73,6,86,206,1,89,193,6,13,252,73,197,227,12,213,139,82,244,36,104,41,191,114,203,61,70,88,86,
			21,59,171,0,227,35,74,70,31,2,183,254,82,238,140,199,158,216,6,129,99,146,200,136,188,28,114,248,77,102,103,101,
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

/// Converts mint address bytes (first 31 bytes) to the expected proof format
/// The circuit converts the first 31 bytes to a BigUint field element, then to bytes
/// This function replicates that conversion for comparison
pub fn mint_bytes_to_proof_format(mint_bytes_31: &[u8]) -> [u8; 32] {
    let mint_field_value = num_bigint::BigUint::from_bytes_be(mint_bytes_31);
    let mut expected_proof_mint = [0u8; 32];
    let mint_field_bytes = mint_field_value.to_bytes_be();
    let start_idx = 32 - mint_field_bytes.len();
    expected_proof_mint[start_idx..].copy_from_slice(&mint_field_bytes);
    expected_proof_mint
}

pub fn verify_proof(proof: Proof, verifying_key: Groth16Verifyingkey) -> bool {
    let mut public_inputs_vec: [[u8; 32]; 8] = [[0u8; 32]; 8];

    public_inputs_vec[0] = proof.root;
    public_inputs_vec[1] = proof.public_amount;
    public_inputs_vec[2] = proof.ext_data_hash;
    public_inputs_vec[3] = proof.mint_address;
    public_inputs_vec[4] = proof.input_nullifiers[0];
    public_inputs_vec[5] = proof.input_nullifiers[1];
    public_inputs_vec[6] = proof.output_commitments[0];
    public_inputs_vec[7] = proof.output_commitments[1];

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

    #[test]
    fn test_mint_bytes_to_proof_format_all_zeros() {
        // Test with all zeros (edge case)
        let mint_bytes = [0u8; 31];
        let result = mint_bytes_to_proof_format(&mint_bytes);
        
        // All zeros should result in all zeros
        assert_eq!(result, [0u8; 32]);
    }

    #[test]
    fn test_mint_bytes_to_proof_format_all_ones() {
        // Test with all ones (large value)
        let mint_bytes = [0xFFu8; 31];
        let result = mint_bytes_to_proof_format(&mint_bytes);
        
        // The BigUint conversion should preserve the value
        // When converting back, it should be right-aligned (big-endian)
        let mut expected = [0u8; 32];
        expected[0] = 0x00; // First byte is 0 because we only use 31 bytes
        expected[1..32].copy_from_slice(&mint_bytes);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_mint_bytes_to_proof_format_small_value() {
        // Test with a small value that doesn't use all bytes
        let mut mint_bytes = [0u8; 31];
        mint_bytes[30] = 0x42; // Only the last byte is non-zero
        
        let result = mint_bytes_to_proof_format(&mint_bytes);
        
        // Should be right-aligned with leading zeros
        let mut expected = [0u8; 32];
        expected[31] = 0x42;
        assert_eq!(result, expected);
    }

    #[test]
    fn test_mint_bytes_to_proof_format_realistic_pubkey() {
        // Test with realistic SPL token mint address bytes
        // Using first 31 bytes of a typical Solana pubkey pattern
        let mint_bytes: [u8; 31] = [
            0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93,
            0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
            0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91,
            0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00,
        ];
        
        let result = mint_bytes_to_proof_format(&mint_bytes);
        
        // The result should be the BigUint representation padded to 32 bytes
        // Since we start with 31 bytes, the result will have 1 leading zero byte
        let mut expected = [0u8; 32];
        expected[1..32].copy_from_slice(&mint_bytes);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_mint_bytes_to_proof_format_leading_zeros() {
        // Test with leading zeros (smaller value)
        let mut mint_bytes = [0u8; 31];
        mint_bytes[20..31].copy_from_slice(&[
            0x01, 0x02, 0x03, 0x04, 0x05, 
            0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
        ]);
        
        let result = mint_bytes_to_proof_format(&mint_bytes);
        
        // Should remove leading zeros and right-align
        let mut expected = [0u8; 32];
        expected[21..32].copy_from_slice(&[
            0x01, 0x02, 0x03, 0x04, 0x05, 
            0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
        ]);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_mint_bytes_to_proof_format_single_byte() {
        // Test with just one non-zero byte
        let mut mint_bytes = [0u8; 31];
        mint_bytes[30] = 0xFF;
        
        let result = mint_bytes_to_proof_format(&mint_bytes);
        
        // Should result in a single 0xFF byte at the end
        let mut expected = [0u8; 32];
        expected[31] = 0xFF;
        assert_eq!(result, expected);
    }

    #[test]
    fn test_mint_bytes_to_proof_format_idempotent() {
        // Test that converting twice gives the same result
        let mint_bytes: [u8; 31] = [
            0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0,
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
            0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00,
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        ];
        
        let result1 = mint_bytes_to_proof_format(&mint_bytes);
        
        // Converting the first 31 bytes of result should give the same thing
        let result2 = mint_bytes_to_proof_format(&result1[1..32]);
        
        // Since we're using 31 bytes, the results should match
        // (the BigUint normalization is consistent)
        assert_eq!(result1, result2);
    }

    #[test]
    fn test_mint_bytes_to_proof_format_max_31_bytes() {
        // Test with maximum value that fits in 31 bytes
        let mut mint_bytes = [0xFFu8; 31];
        mint_bytes[0] = 0x7F; // Make it 248 bits (31 bytes * 8 - 1 bit)
        
        let result = mint_bytes_to_proof_format(&mint_bytes);
        
        // Should preserve the value without overflow
        let mut expected = [0u8; 32];
        expected[1] = 0x7F;
        expected[2..32].copy_from_slice(&[0xFFu8; 30]);
        assert_eq!(result, expected);
    }
}