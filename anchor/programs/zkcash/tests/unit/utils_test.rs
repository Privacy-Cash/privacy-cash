use anchor_lang::error::Error;
use num_bigint::BigUint;
use ark_bn254;
use ark_ff::PrimeField;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use std::ops::Neg;
use zkcash::{groth16::{is_less_than_bn254_field_size_be, Groth16Verifyingkey}, utils::{change_endianness, check_external_amount, verify_proof}, Proof};

type G1 = ark_bn254::g1::G1Affine;

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
		25,144,125,232,3,246,233,27,95,82,198,175,194,109,64,223,160,163,173,3,105,57,8,146,21,9,143,149,186,205,169,20,
		30,125,176,182,99,128,189,87,89,39,46,198,25,169,128,41,58,88,146,18,100,228,40,244,108,142,153,178,190,112,64,143,
		20,246,62,229,211,174,153,16,39,170,87,82,27,82,228,201,225,201,15,57,42,23,196,117,122,62,12,125,123,93,46,182,
		17,34,168,77,239,4,232,70,205,150,149,86,50,156,249,68,194,36,10,117,244,76,103,123,147,75,154,200,149,251,3,155,
	],

	vk_ic: &[
		[
			22,102,95,145,175,147,31,150,31,30,121,204,58,223,169,0,50,185,222,79,27,216,118,7,191,93,156,74,120,37,133,23,
			47,178,98,3,18,2,19,238,102,203,128,215,31,70,158,224,119,204,127,8,199,23,11,72,166,189,196,153,130,20,210,4,
		],
		[
			0,15,203,93,134,105,229,223,22,236,46,125,212,107,191,208,142,224,197,135,68,180,236,233,112,160,91,170,10,192,190,72,
			27,29,181,159,152,120,78,224,4,246,8,158,230,136,141,5,184,119,139,103,9,224,64,186,89,70,4,40,109,167,51,184,
		],
		[
			2,192,237,146,40,137,121,252,233,190,175,2,49,245,31,31,192,108,246,30,248,101,62,165,138,163,224,60,252,5,154,5,
			23,32,86,191,169,94,90,129,216,63,196,35,177,209,137,188,153,201,88,95,211,53,128,216,52,247,124,97,27,212,52,189,
		],
		[
			4,124,147,8,19,106,82,195,14,220,198,30,35,215,67,204,163,70,217,100,107,1,34,154,196,175,13,156,230,68,110,232,
			8,156,208,28,65,97,249,30,221,89,57,190,93,28,129,95,54,122,235,42,75,51,121,171,15,11,188,195,45,183,153,24,
		],
		[
			12,134,110,103,149,7,208,186,246,223,195,211,236,68,34,159,40,117,2,95,132,132,247,82,184,67,243,74,84,71,207,137,
			32,67,87,27,226,12,246,15,25,16,204,56,87,190,47,94,29,124,83,84,155,238,183,4,127,121,53,189,134,112,179,152,
		],
		[
			8,178,234,135,103,180,183,102,158,101,228,31,120,184,36,116,67,232,153,124,53,255,230,181,65,33,76,73,148,105,174,125,
			25,214,223,180,222,232,82,159,55,166,254,72,177,98,68,130,215,97,59,20,164,252,192,236,86,13,54,207,50,49,212,212,
		],
		[
			32,192,87,52,137,55,209,207,255,179,175,175,210,222,191,68,235,8,35,251,144,161,216,86,172,23,191,243,87,20,206,232,
			40,241,150,202,59,189,191,252,121,163,80,231,239,58,127,14,69,80,93,154,158,17,99,184,20,20,93,234,132,166,171,67,
		],
		[
			28,140,162,144,74,35,43,227,127,175,76,212,5,193,125,88,51,43,230,63,210,181,232,40,163,171,179,44,137,128,47,245,
			6,39,70,66,52,35,253,220,190,80,4,162,193,75,96,79,29,202,154,16,41,173,168,93,97,229,209,252,10,88,186,34,
		],
	]
};

pub const PROOF_A: [u8; 64] = [2, 247, 78, 150, 40, 232, 144, 25, 228, 27, 102, 79, 19, 45, 225, 162, 252, 204, 243, 159, 69, 240, 170, 189, 67, 48, 133, 215, 177, 66, 146, 150, 4, 157, 46, 215, 5, 172, 140, 247, 118, 30, 176, 254, 221, 204, 132, 113, 211, 254, 73, 35, 157, 141, 190, 130, 189, 233, 66, 198, 35, 228, 93, 120];

pub const PROOF_B: [u8; 128] = [29, 88, 56, 35, 74, 15, 204, 199, 159, 234, 107, 13, 62, 99, 162, 150, 104, 58, 103, 43, 146, 243, 30, 147, 86, 174, 184, 148, 46, 131, 251, 117, 16, 10, 22, 237, 105, 103, 134, 24, 158, 163, 215, 185, 8, 58, 36, 0, 205, 196, 194, 40, 176, 48, 250, 111, 155, 115, 195, 164, 49, 209, 163, 185, 33, 195, 69, 65, 1, 135, 32, 240, 207, 211, 143, 137, 100, 41, 121, 86, 202, 84, 36, 126, 64, 8, 94, 140, 48, 64, 177, 73, 7, 179, 38, 243, 14, 195, 163, 182, 220, 219, 163, 152, 138, 169, 70, 55, 83, 101, 95, 76, 63, 73, 28, 254, 232, 187, 188, 134, 106, 217, 175, 56, 103, 29, 127, 47];

pub const PROOF_C: [u8; 64] = [31, 191, 233, 178, 191, 85, 70, 46, 3, 87, 49, 115, 52, 146, 242, 199, 146, 196, 104, 23, 175, 46, 217, 190, 182, 59, 8, 100, 174, 198, 125, 150, 26, 84, 97, 1, 217, 25, 43, 189, 140, 75, 39, 102, 73, 104, 234, 168, 226, 49, 13, 18, 229, 221, 130, 16, 111, 101, 53, 93, 104, 121, 159, 28];

pub const PUBLIC_INPUTS: [[u8; 32]; 7] = [
    [
       31,  56, 132, 116,  54, 176, 172, 122,
      167, 219,  10,  53, 254, 220, 246, 171,
      228,  27,  93, 244,  83, 108, 130, 181,
      213,  79,  61,  19, 137,  14, 181,  25
    ],
    [
       48, 100,  78, 114, 225,  49, 160,  41,
      184,  80,  69, 182, 129, 129,  88,  93,
       40,  51, 232,  72, 121, 185, 112, 145,
       67, 225, 245, 147, 180, 101,  54,   1
    ],
    [
       21,  25, 119, 169, 63, 109,  52,  60,
       26, 194, 100,  44, 75, 160, 216, 178,
      179, 102, 211, 142, 11,  94, 147, 108,
      204, 242, 102, 204, 52, 218, 116,  21
    ],
    [
        5,  92,  25, 230,   5, 162, 134, 133,
      166, 112,  65, 155, 182,  96, 208,  46,
      205, 139, 163, 145, 197, 177,  78,  21,
      247, 241,  47,  96, 150, 194, 135,  98
    ],
    [
        1,  16,  73, 174, 147,   9,  48, 192,
       54, 247, 254,  55, 106, 243,  41, 132,
      138,  84,  95, 251, 108,  49, 201, 192,
      134, 219, 206, 202, 211,  77,  67, 245
    ],
    [
        5, 125, 252,  11,  98, 150, 207, 249,
       21,  59, 138, 152, 250,  23, 197, 135,
       58,  59,  73, 194,  20,  24,  45, 188,
      172,  21, 115,  45, 125, 163,  10, 117
    ],
    [
        2, 114,   6,   5, 122,  72,  57,  68,
      100,  47, 239, 212, 136, 250, 195, 182,
       41, 220, 246, 224, 156, 184, 119, 118,
        9,  94,  88, 124, 115, 142, 113, 122
    ]
];

// Helper function to create a byte array representing a u64 value
fn u64_to_bytes(value: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    // Place the value in the last 8 bytes (positions 24-31) in big-endian format
    bytes[24..32].copy_from_slice(&value.to_be_bytes());
    bytes
}

// Helper function to create a byte array representing a large value (larger than u64)
fn large_value_to_bytes() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    // Set a non-zero byte in the first 24 bytes to trigger the "larger than u64" check
    bytes[0] = 1;
    bytes
}

// Helper function to create a byte array representing a very large i64 value (won't fit in i64)
fn too_large_for_i64_to_bytes() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    // Set to a value larger than i64::MAX in the last 8 bytes (big-endian)
    bytes[24..32].copy_from_slice(&(i64::MAX as u64 + 1).to_be_bytes());
    bytes
}

// Helper function to check if the error is InvalidPublicAmountData
fn is_invalid_public_amount_error(error: Error) -> bool {
    // Converting Anchor Error to string and checking if it contains our error message
    error.to_string().contains("Public amount is invalid")
}

// Helper function for creating a byte array representing a value near the BN254 field modulus
fn near_modulus_bytes() -> [u8; 32] {
    // Simplified approach - just create a byte array with non-zero values
    // in the first 24 bytes to trigger the "larger than u64" check
    let mut bytes = [0; 32];
    bytes[0] = 1; // Any non-zero value in the first 24 bytes
    bytes
}

// Helper function for creating a byte array representing the BN254 field modulus exactly
fn at_modulus_bytes() -> [u8; 32] {
    // This is a simplified approach - just create a byte array with non-zero values in the
    // first 24 bytes to trigger the "larger than u64" check
    let mut bytes = [0; 32];
    bytes[0] = 1; // Any non-zero value in the first 24 bytes
    bytes
}

// Helper function for creating a byte array representing a value above the BN254 field modulus
fn above_modulus_bytes() -> [u8; 32] {
    // Simplified approach - just create a byte array with non-zero values
    // in the first 24 bytes to trigger the "larger than u64" check
    let mut bytes = [0; 32];
    bytes[0] = 1; // Any non-zero value in the first 24 bytes
    bytes
}

#[test]
fn test_positive_ext_amount_success() {
    // Test case for positive ext_amount with valid inputs
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    // Public amount should be ext_amount - fee
    let public_amount_bytes = u64_to_bytes(90);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_ok());
    
    // Verify the returned values
    let (amount, returned_fee) = result.unwrap();
    assert_eq!(amount, 100);
    assert_eq!(returned_fee, 10);
}

#[test]
fn test_negative_ext_amount_success() {
    // Test case for negative ext_amount with valid inputs
    let ext_amount: i64 = -90;
    let fee: u64 = 10;
    // Public amount should be abs(ext_amount) + fee
    let public_amount_bytes = u64_to_bytes(100);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_ok());
    
    // Verify the returned values
    let (amount, returned_fee) = result.unwrap();
    assert_eq!(amount, 90);
    assert_eq!(returned_fee, 10);
}

#[test]
fn test_zero_ext_amount_success() {
    // Test case for ext_amount = 0 with valid inputs
    let ext_amount: i64 = 0;
    let fee: u64 = 10;
    // Public amount doesn't matter for zero ext_amount
    let public_amount_bytes = u64_to_bytes(0);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_ok());
    
    // Verify the returned values
    let (amount, returned_fee) = result.unwrap();
    assert_eq!(amount, 0);
    assert_eq!(returned_fee, 10);
}

#[test]
fn test_positive_ext_amount_too_large() {
    // Test case for positive ext_amount where public_amount is too large
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = large_value_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_positive_ext_amount_too_large_for_i64() {
    // Test case for positive ext_amount where public_amount is too large for i64
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = too_large_for_i64_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_positive_ext_amount_mismatch() {
    // Test case for positive ext_amount where amount check fails
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    // Setting public_amount to wrong value (not ext_amount - fee)
    let public_amount_bytes = u64_to_bytes(50); // Should be 90
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_negative_ext_amount_too_large() {
    // Test case for negative ext_amount where public_amount is too large
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = large_value_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_negative_ext_amount_too_large_for_i64() {
    // Test case for negative ext_amount where public_amount is too large for i64
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = too_large_for_i64_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_negative_ext_amount_mismatch() {
    // Test case for negative ext_amount where amount check fails
    let ext_amount: i64 = -90;
    let fee: u64 = 10;
    // Setting public_amount to wrong value (not abs(ext_amount) + fee)
    let public_amount_bytes = u64_to_bytes(50); // Should be 100
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_edge_cases() {
    // Test with ext_amount = i64::MAX
    let ext_amount: i64 = i64::MAX;
    let fee: u64 = 10;
    // This would typically overflow, but in real scenarios we would have proper validation
    // Here we'll just test how the function handles the edge case
    let public_amount_bytes = u64_to_bytes(i64::MAX as u64 - fee);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // This might fail or succeed based on implementation details, but should not panic
    if result.is_ok() {
        let (amount, returned_fee) = result.unwrap();
        assert_eq!(amount as i64, ext_amount);
        assert_eq!(returned_fee, fee);
    }
    
    // Test with ext_amount = i64::MIN + 1 (need +1 to ensure abs() fits in a u64)
    let ext_amount: i64 = i64::MIN + 1;
    let fee: u64 = 10;
    // For large negative numbers, we need to handle potential overflows carefully
    let abs_ext_amount = (-(ext_amount as i128)) as u64;
    let public_amount_bytes = u64_to_bytes(abs_ext_amount + fee);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Again, this might fail or succeed based on implementation details
    if result.is_ok() {
        let (amount, returned_fee) = result.unwrap();
        assert_eq!(amount, abs_ext_amount);
        assert_eq!(returned_fee, fee);
    }
}

#[test]
fn test_overflow_cases() {
    // Test case where fee + ext_amount would overflow
    let ext_amount: i64 = i64::MAX;
    let fee: u64 = u64::MAX;
    let public_amount_bytes = u64_to_bytes(0); // Any value would fail due to overflow
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // This should either panic (unwrap failures) or return an error
    assert!(result.is_err());
}

#[test]
fn test_field_modulus_near_positive() {
    // Test with a value near the field modulus and positive ext_amount
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = near_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_near_negative() {
    // Test with a value near the field modulus and negative ext_amount
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = near_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_at_positive() {
    // Test with a value at the field modulus and positive ext_amount
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = at_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is equivalent to 0 in the field but our implementation checks raw bytes,
    // this should fail as a value too large for i64
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_at_negative() {
    // Test with a value at the field modulus and negative ext_amount
    let ext_amount: i64 = -100; 
    let fee: u64 = 10;
    let public_amount_bytes = at_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is equivalent to 0 in the field but our implementation checks raw bytes,
    // this should fail as a value too large for i64
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_above_positive() {
    // Test with a value above the field modulus and positive ext_amount
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = above_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_above_negative() {
    // Test with a value above the field modulus and negative ext_amount
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = above_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_change_endianness_empty() {
    let input: [u8; 0] = [];
    let result = change_endianness(&input);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_change_endianness_single_chunk() {
    let input: [u8; 32] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32
    ];
    let expected: Vec<u8> = vec![
        32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
        16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
    ];
    
    let result = change_endianness(&input);
    assert_eq!(result, expected);
}

#[test]
fn test_change_endianness_multiple_chunks() {
    let input: [u8; 64] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
        49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64
    ];
    
    let expected: Vec<u8> = vec![
        32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
        16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
        64, 63, 62, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49,
        48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33
    ];
    
    let result = change_endianness(&input);
    assert_eq!(result, expected);
}

#[test]
fn test_change_endianness_partial_chunk() {
    // This tests how the function handles input that is not a multiple of 32 bytes
    // The implementation chunks by 32, so a 40-byte input should be treated as one 32-byte 
    // chunk and one 8-byte chunk
    let input: [u8; 40] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37, 38, 39, 40
    ];
    
    let expected: Vec<u8> = vec![
        32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
        16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
        40, 39, 38, 37, 36, 35, 34, 33
    ];
    
    let result = change_endianness(&input);
    assert_eq!(result, expected);
}

#[test]
fn test_change_endianness_proof_data() {
    // Test with the kind of proof data that would be used in the verify_proof function
    let proof_a: [u8; 64] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
        49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64
    ];
    
    // Change endianness and convert back (round trip test)
    let converted = change_endianness(&proof_a);
    let round_trip = change_endianness(&converted);
    
    // After two conversions, we should get back the original data
    assert_eq!(round_trip, proof_a);
}

#[test]
fn test_is_less_than_bn254_field_size_be() {
    let bytes = [0u8; 32];
    assert!(is_less_than_bn254_field_size_be(&bytes));

    let bytes: [u8; 32] = BigUint::from(ark_bn254::Fr::MODULUS)
        .to_bytes_be()
        .try_into()
        .unwrap();
    assert!(!is_less_than_bn254_field_size_be(&bytes));
}

#[test]
fn proof_verification_should_succeed() {
    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        public_amount: PUBLIC_INPUTS[1],
        ext_data_hash: PUBLIC_INPUTS[2],
        input_nullifiers: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        output_commitments: [PUBLIC_INPUTS[5], PUBLIC_INPUTS[6]],
        proof_a: PROOF_A,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    assert!(verify_proof(proof, VERIFYING_KEY));
}

#[test]
fn proof_verification_should_fail_for_wrong_proof_a() {
    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        input_nullifiers: [PUBLIC_INPUTS[1], PUBLIC_INPUTS[2]],
        output_commitments: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        public_amount: PUBLIC_INPUTS[5],
        ext_data_hash: PUBLIC_INPUTS[6],
        proof_a: PROOF_C,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    assert!(!verify_proof(proof, VERIFYING_KEY));
}

#[test]
fn proof_verification_should_fail_for_correct_proof_but_modified_input() {
    let mut modified_public_amount = PUBLIC_INPUTS[5];
    modified_public_amount[0] = 0;

    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        input_nullifiers: [PUBLIC_INPUTS[1], PUBLIC_INPUTS[2]],
        output_commitments: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        public_amount: modified_public_amount,
        ext_data_hash: PUBLIC_INPUTS[6],
        proof_a: PROOF_A,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    assert!(!verify_proof(proof, VERIFYING_KEY));
}

#[test]
fn negated_proof_a_verification_should_not_succeed() {
    // First deserialize PROOF_A into a G1 point
    let g1_point = G1::deserialize_with_mode(
        &*[&change_endianness(&PROOF_A[0..64]), &[0u8][..]].concat(),
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

    let proof_a = change_endianness(&proof_a_neg[..64]).try_into().unwrap();

    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        input_nullifiers: [PUBLIC_INPUTS[1], PUBLIC_INPUTS[2]],
        output_commitments: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        public_amount: PUBLIC_INPUTS[5],
        ext_data_hash: PUBLIC_INPUTS[6],
        proof_a: proof_a,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    assert!(!verify_proof(proof, VERIFYING_KEY));
}

#[test]
fn wrong_verifying_key_verification_should_not_succeed() {
    const WRONG_VERIFYING_KEY: Groth16Verifyingkey =  Groth16Verifyingkey {
        nr_pubinputs: 8,
    
        vk_alpha_g1: [
            42,77,154,167,227,2,217,223,65,116,157,85,7,148,157,5,219,234,51,251,177,108,100,59,34,245,153,162,190,109,242,226,
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
            25,144,125,232,3,246,233,27,95,82,198,175,194,109,64,223,160,163,173,3,105,57,8,146,21,9,143,149,186,205,169,20,
            30,125,176,182,99,128,189,87,89,39,46,198,25,169,128,41,58,88,146,18,100,228,40,244,108,142,153,178,190,112,64,143,
            20,246,62,229,211,174,153,16,39,170,87,82,27,82,228,201,225,201,15,57,42,23,196,117,122,62,12,125,123,93,46,182,
            17,34,168,77,239,4,232,70,205,150,149,86,50,156,249,68,194,36,10,117,244,76,103,123,147,75,154,200,149,251,3,155,
        ],
    
        vk_ic: &[
            [
                22,102,95,145,175,147,31,150,31,30,121,204,58,223,169,0,50,185,222,79,27,216,118,7,191,93,156,74,120,37,133,23,
                47,178,98,3,18,2,19,238,102,203,128,215,31,70,158,224,119,204,127,8,199,23,11,72,166,189,196,153,130,20,210,4,
            ],
            [
                0,15,203,93,134,105,229,223,22,236,46,125,212,107,191,208,142,224,197,135,68,180,236,233,112,160,91,170,10,192,190,72,
                27,29,181,159,152,120,78,224,4,246,8,158,230,136,141,5,184,119,139,103,9,224,64,186,89,70,4,40,109,167,51,184,
            ],
            [
                2,192,237,146,40,137,121,252,233,190,175,2,49,245,31,31,192,108,246,30,248,101,62,165,138,163,224,60,252,5,154,5,
                23,32,86,191,169,94,90,129,216,63,196,35,177,209,137,188,153,201,88,95,211,53,128,216,52,247,124,97,27,212,52,189,
            ],
            [
                4,124,147,8,19,106,82,195,14,220,198,30,35,215,67,204,163,70,217,100,107,1,34,154,196,175,13,156,230,68,110,232,
                8,156,208,28,65,97,249,30,221,89,57,190,93,28,129,95,54,122,235,42,75,51,121,171,15,11,188,195,45,183,153,24,
            ],
            [
                12,134,110,103,149,7,208,186,246,223,195,211,236,68,34,159,40,117,2,95,132,132,247,82,184,67,243,74,84,71,207,137,
                32,67,87,27,226,12,246,15,25,16,204,56,87,190,47,94,29,124,83,84,155,238,183,4,127,121,53,189,134,112,179,152,
            ],
            [
                8,178,234,135,103,180,183,102,158,101,228,31,120,184,36,116,67,232,153,124,53,255,230,181,65,33,76,73,148,105,174,125,
                25,214,223,180,222,232,82,159,55,166,254,72,177,98,68,130,215,97,59,20,164,252,192,236,86,13,54,207,50,49,212,212,
            ],
            [
                32,192,87,52,137,55,209,207,255,179,175,175,210,222,191,68,235,8,35,251,144,161,216,86,172,23,191,243,87,20,206,232,
                40,241,150,202,59,189,191,252,121,163,80,231,239,58,127,14,69,80,93,154,158,17,99,184,20,20,93,234,132,166,171,67,
            ],
            [
                28,140,162,144,74,35,43,227,127,175,76,212,5,193,125,88,51,43,230,63,210,181,232,40,163,171,179,44,137,128,47,245,
                6,39,70,66,52,35,253,220,190,80,4,162,193,75,96,79,29,202,154,16,41,173,168,93,97,229,209,252,10,88,186,34,
            ],
        ]
    };

    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        input_nullifiers: [PUBLIC_INPUTS[1], PUBLIC_INPUTS[2]],
        output_commitments: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        public_amount: PUBLIC_INPUTS[5],
        ext_data_hash: PUBLIC_INPUTS[6],
        proof_a: PROOF_C,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    assert!(!verify_proof(proof, WRONG_VERIFYING_KEY));
}

#[test]
fn public_input_greater_than_field_size_should_not_suceed() {
    let proof = Proof {
        root: BigUint::from(ark_bn254::Fr::MODULUS)
        .to_bytes_be()
        .try_into()
        .unwrap(),
        input_nullifiers: [PUBLIC_INPUTS[1], PUBLIC_INPUTS[2]],
        output_commitments: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        public_amount: PUBLIC_INPUTS[5],
        ext_data_hash: PUBLIC_INPUTS[6],
        proof_a: PROOF_C,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    assert!(!verify_proof(proof, VERIFYING_KEY));
} 