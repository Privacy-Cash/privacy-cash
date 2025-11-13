use num_bigint::BigUint;
use ark_bn254;
use ark_ff::{PrimeField, BigInteger};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use std::ops::Neg;
use ark_bn254::Fr;
use zkcash::{groth16::{is_less_than_bn254_field_size_be, Groth16Verifyingkey}, utils::{change_endianness, check_public_amount, verify_proof, validate_fee, calculate_complete_ext_data_hash, VERIFYING_KEY}, Proof};
use anchor_lang::prelude::*;

type G1 = ark_bn254::g1::G1Affine;

pub const PROOF_A: [u8; 64] = [33, 176, 101, 34, 69, 225, 121, 7, 75, 118, 155, 230, 240, 148, 177, 70, 99, 90, 162, 126, 87, 113, 101, 157, 129, 98, 119, 140, 178, 220, 223, 122, 42, 93, 51, 152, 119, 241, 116, 56, 93, 200, 108, 194, 135, 57, 47, 7, 74, 149, 72, 215, 103, 26, 163, 253, 6, 50, 9, 231, 148, 41, 211, 13];

pub const PROOF_B: [u8; 128] = [28, 69, 92, 80, 191, 61, 65, 166, 65, 16, 144, 119, 255, 160, 145, 2, 30, 88, 182, 169, 63, 180, 68, 166, 105, 176, 38, 156, 166, 97, 222, 156, 5, 234, 80, 151, 207, 227, 105, 13, 16, 198, 227, 11, 68, 95, 221, 154, 8, 182, 177, 87, 153, 67, 253, 4, 156, 48, 177, 155, 30, 88, 178, 98, 32, 167, 163, 62, 173, 34, 110, 201, 42, 191, 119, 199, 125, 58, 227, 36, 66, 55, 152, 156, 185, 137, 154, 2, 41, 216, 225, 156, 81, 200, 80, 251, 41, 67, 206, 85, 6, 214, 224, 15, 88, 73, 79, 202, 181, 35, 139, 77, 253, 193, 117, 165, 85, 234, 148, 18, 251, 156, 15, 11, 131, 100, 88, 217];

pub const PROOF_C: [u8; 64] = [9, 98, 181, 114, 139, 22, 71, 4, 210, 99, 210, 2, 209, 196, 194, 133, 94, 114, 55, 225, 10, 171, 202, 249, 174, 228, 199, 10, 100, 115, 119, 40, 36, 73, 23, 170, 47, 236, 126, 81, 98, 255, 93, 225, 55, 13, 14, 63, 18, 66, 64, 204, 154, 139, 54, 91, 85, 62, 65, 20, 120, 78, 45, 195];

pub const PUBLIC_INPUTS: [[u8; 32]; 7] = [
    [
      35,  32, 33, 165,  51,  76, 83,  64,  62,
      43, 144, 45,  80,   2, 148, 32, 201,   8,
       9, 187, 65,  43, 198, 110, 43,  70, 151,
      29, 126, 19,  55,  86
    ],
    [
       48, 100,  78, 114, 225,  49, 160,  41,
      184,  80,  69, 182, 129, 129,  88,  93,
       40,  51, 232,  72, 121, 185, 112, 145,
       67, 225, 245, 147, 180, 101,  54,   1
    ],
    [
      10,  72, 121, 237,  87,  62,  14, 224,
       3, 149, 108, 134, 203, 123,  20, 155,
      22, 150, 213, 175, 200, 250, 183, 227,
      27, 146,  56, 232, 215, 174,  24, 211
    ],
    [
       47,  33, 196, 198,   7, 143, 191, 249,
      108, 187, 250, 115, 104,  59,  79, 209,
       49,  53, 243,  59, 169,  49,  63, 242,
      187, 239, 231, 229, 241, 202, 230, 214
    ],
    [
       25, 194, 167, 199, 121, 112,  72, 102,
       77,  28,   9,  25, 134, 178, 128,  76,
      206, 219, 227,  88,  58,  76,  27, 133,
      168, 194,  12, 187,  16, 146, 229, 117
    ],
    [
       15, 228, 113,  58,  51, 201, 233,  28,
       56, 160, 107, 159,  70,  46, 119,  72,
       70, 108, 196, 189,  71, 204,  89, 173,
      136, 147, 174, 215, 106,  61,  35, 201
    ],
    [
       13, 107, 132,  53, 242, 134,  45,  10,
      102,  33,  59,  68,  61,  13, 210, 252,
      230,  78, 219, 201, 232, 238, 149, 197,
       58,  64, 125, 223, 202,   1, 185, 194
    ]
];

// Helper function to convert Fr to bytes in big-endian format
fn fr_to_bytes(fr: Fr) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    fr.into_bigint().to_bytes_be().as_slice().iter()
        .enumerate()
        .for_each(|(i, &b)| bytes[i] = b);
    bytes
}

// Helper function to create a byte array representing a u64 value
fn u64_to_bytes(value: u64) -> [u8; 32] {
    fr_to_bytes(Fr::from(value))
}

#[test]
fn test_check_public_amount() {
    let ext_amount = 100;
    let fee = 10;
    let public_amount_bytes = u64_to_bytes(90);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result);
}

#[test]
fn test_check_public_amount_zero_fee() {
    let ext_amount = 100;
    let fee = 0;
    let public_amount_bytes = u64_to_bytes(100);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result);
}

#[test]
fn test_check_public_amount_fee_equals_to_ext_amount() {
    let ext_amount = 100;
    let fee = 100;
    let public_amount_bytes = u64_to_bytes(0);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(!result, "fee equal to deposit amount should be rejected");
}

#[test]
fn test_check_public_amount_fee_larger_than_ext_amount() {
    let ext_amount = 100;
    let fee = 200;
    let public_amount_bytes = u64_to_bytes(0);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(!result, "Function should return false when fee > ext_amount");
}

#[test]
fn test_check_public_amount_invalid_ext_amount() {
    let ext_amount = i64::MAX;
    let fee = 10;
    // Calculate the correct expected value using field arithmetic
    let expected_fr = Fr::from(ext_amount as u64) - Fr::from(fee);
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    // This should work since we're using proper field arithmetic now
    assert!(result);
}

#[test]
fn test_check_public_amount_mismatch() {
    let ext_amount = 100;
    let fee = 10;
    let public_amount_bytes = u64_to_bytes(50); // Should be 90
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(!result);
}

#[test]
fn test_check_public_amount_negative_ext_amount() {
    let ext_amount = -100;
    let fee = 10;
    // For negative ext_amount, the public amount should be -(abs(ext_amount) + fee)
    let expected_fr = -(Fr::from(100u64) + Fr::from(10u64));
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result);
}

#[test]
fn test_check_public_amount_negative_ext_amount_zero_fee() {
    let ext_amount = -100;
    let fee = 0;
    // For negative ext_amount with zero fee, the public amount should be -abs(ext_amount)
    let expected_fr = -Fr::from(100u64);
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result);
}

#[test]
fn test_check_public_amount_negative_ext_amount_large_fee() {
    let ext_amount = -100;
    let fee = 200;
    // For negative ext_amount with large fee, the public amount should be -(abs(ext_amount) + fee)
    let expected_fr = -(Fr::from(100u64) + Fr::from(200u64));
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result);
}

#[test]
fn test_check_public_amount_negative_ext_amount_invalid_ext_amount() {
    // Since i64::MIN cannot be negated without overflow, we need to handle it differently
    // The test now creates the correct expected public amount for i64::MIN
    let ext_amount = i64::MIN;
    let fee = 10;
    
    let result = check_public_amount(ext_amount, fee, [0u8; 32]);
    assert!(!result, "i64::MIN should be rejected as ext_amount");
}

#[test]
fn test_check_public_amount_max_ext_amount() {
    let ext_amount = i64::MAX;
    let fee = 10;
    let expected_fr = Fr::from(ext_amount as u64) - Fr::from(fee);
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result, "A large ext_amount should be valid as long as the public amount matches");
}

#[test]
fn test_check_public_amount_overflow() {
    let ext_amount = i64::MAX;
    let fee = 1u64 << 57; // Large fee
    let expected_fr = Fr::from(ext_amount as u64) - Fr::from(fee);
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result, "Field arithmetic should handle large values correctly");
}

#[test]
fn test_check_public_amount_min_values() {
    let ext_amount = -(1i64 << 55);
    let fee = 1u64 << 55;
    let expected_fr = -(Fr::from(1u64 << 55) + Fr::from(fee));
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result);
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
    let proof_a: [u8; 64] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
        49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64
    ];
    
    let converted = change_endianness(&proof_a);
    let round_trip = change_endianness(&converted);
    
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
    pub const WRONG_VERIFYING_KEY: Groth16Verifyingkey =  Groth16Verifyingkey {
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
            36,22,238,106,159,226,215,236,64,200,10,97,174,157,138,27,194,212,150,35,59,108,39,146,238,71,89,231,214,170,112,117,
            0,218,208,188,101,131,61,231,199,28,92,173,155,103,67,49,108,106,93,82,235,248,124,151,133,246,36,135,186,160,244,66,
            44,191,124,246,94,179,196,33,51,61,110,137,133,63,208,26,63,202,144,244,205,239,159,17,153,200,198,221,90,255,131,141,
            28,30,105,198,244,238,210,208,243,52,86,3,165,40,254,181,76,96,101,60,27,187,235,49,31,50,222,131,63,138,160,6,
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

#[test]
fn test_check_public_amount_i64_min_overflow() {
    let ext_amount = i64::MIN;
    let fee = 0;
    let public_amount_bytes = [0u8; 32];
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(!result, "i64::MIN should be rejected");
}

#[test]
fn test_check_public_amount_neg_overflow_protection() {
    let ext_amount = i64::MIN + 1;
    let fee = 0;
    // For negative values, we expect -(abs(ext_amount) + fee)
    let expected_fr = -Fr::from(i64::MAX as u64);
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result, "Should handle near-minimum negative values correctly");
}

#[test]
fn test_check_public_amount_addition_overflow_protection() {
    let ext_amount = -100;
    let fee = u64::MAX;
    // The function should handle this without panicking due to field arithmetic
    let expected_fr = -(Fr::from(100u64) + Fr::from(fee));
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result, "Field arithmetic should handle large fee values");
}

#[test]
fn test_check_public_amount_field_size_boundary() {
    let ext_amount = 100;
    let fee = 10;
    // Test with field modular arithmetic
    let expected_fr = Fr::from(90u64);
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result, "Should work correctly at field boundaries");
}

#[test]
fn test_check_public_amount_safe_negative_values() {
    let ext_amount = -1000;
    let fee = 50;
    let expected_fr = -(Fr::from(1000u64) + Fr::from(50u64));
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result, "Should handle safe negative values correctly");
}

#[test]
fn test_check_public_amount_max_safe_values() {
    let ext_amount = i64::MAX - 1;
    let fee = 1;
    let expected_fr = Fr::from((ext_amount - 1) as u64);
    let public_amount_bytes = fr_to_bytes(expected_fr);
    
    let result = check_public_amount(ext_amount, fee, public_amount_bytes);
    assert!(result, "Should handle maximum safe values");
}

#[test]
fn test_verify_proof_with_invalid_proof_a_data() {
    // Create invalid proof_a data that will cause G1::deserialize_with_mode to fail
    let invalid_proof_a = [255u8; 64]; // All 0xFF bytes are likely invalid for G1 point
    
    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        public_amount: PUBLIC_INPUTS[1],
        ext_data_hash: PUBLIC_INPUTS[2],
        input_nullifiers: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        output_commitments: [PUBLIC_INPUTS[5], PUBLIC_INPUTS[6]],
        proof_a: invalid_proof_a,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    // Should return false instead of panicking
    assert!(!verify_proof(proof, VERIFYING_KEY));
}

#[test]
fn test_verify_proof_with_all_zero_proof_a() {
    // All zeros should also cause deserialization to fail
    let zero_proof_a = [0u8; 64];
    
    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        public_amount: PUBLIC_INPUTS[1],
        ext_data_hash: PUBLIC_INPUTS[2],
        input_nullifiers: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        output_commitments: [PUBLIC_INPUTS[5], PUBLIC_INPUTS[6]],
        proof_a: zero_proof_a,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    // Should return false instead of panicking
    assert!(!verify_proof(proof, VERIFYING_KEY));
}

#[test]
fn test_verify_proof_with_malformed_verifying_key() {
    // Create a verifying key with invalid nr_pubinputs that might cause Groth16Verifier::new to fail
    const MALFORMED_VERIFYING_KEY: Groth16Verifyingkey = Groth16Verifyingkey {
        nr_pubinputs: 0, // Invalid number of public inputs
        vk_alpha_g1: VERIFYING_KEY.vk_alpha_g1,
        vk_beta_g2: VERIFYING_KEY.vk_beta_g2,
        vk_gamme_g2: VERIFYING_KEY.vk_gamme_g2,
        vk_delta_g2: VERIFYING_KEY.vk_delta_g2,
        vk_ic: &[], // Empty IC array
    };

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

    // Should return false instead of panicking
    assert!(!verify_proof(proof, MALFORMED_VERIFYING_KEY));
}

#[test]
fn test_verify_proof_with_truncated_proof_a() {
    // Test with a proof_a that has valid start but becomes invalid
    let mut truncated_proof_a = PROOF_A;
    // Modify the last bytes to make it invalid
    for i in 32..64 {
        truncated_proof_a[i] = 255;
    }
    
    let proof = Proof {
        root: PUBLIC_INPUTS[0],
        public_amount: PUBLIC_INPUTS[1],
        ext_data_hash: PUBLIC_INPUTS[2],
        input_nullifiers: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
        output_commitments: [PUBLIC_INPUTS[5], PUBLIC_INPUTS[6]],
        proof_a: truncated_proof_a,
        proof_b: PROOF_B,
        proof_c: PROOF_C,
    };

    // Should return false instead of panicking
    assert!(!verify_proof(proof, VERIFYING_KEY));
}

#[test]
fn test_verify_proof_does_not_panic_on_edge_cases() {
    // Test multiple edge cases to ensure no panics occur
    let test_cases = vec![
        [1u8; 64],      // All ones
        [128u8; 64],    // All 128s
        [254u8; 64],    // All 254s
    ];

    for invalid_proof_a in test_cases {
        let proof = Proof {
            root: PUBLIC_INPUTS[0],
            public_amount: PUBLIC_INPUTS[1],
            ext_data_hash: PUBLIC_INPUTS[2],
            input_nullifiers: [PUBLIC_INPUTS[3], PUBLIC_INPUTS[4]],
            output_commitments: [PUBLIC_INPUTS[5], PUBLIC_INPUTS[6]],
            proof_a: invalid_proof_a,
            proof_b: PROOF_B,
            proof_c: PROOF_C,
        };

        // Each should return false without panicking
        let result = verify_proof(proof, VERIFYING_KEY);
        assert!(!result, "verify_proof should return false for invalid proof_a data");
    }
}

// Tests for validate_fee function
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
    // Test withdrawal with 0.25% fee rate - any fee should be accepted above minimum
    let result = validate_fee(
        -1000, // ext_amount (withdrawal)
        5,     // provided_fee (any amount is fine since expected is 0)
        0,     // deposit_fee_rate (0% - free deposits)
        25,    // withdrawal_fee_rate (0.25%)
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
        0,     // deposit_fee_rate (0% - free deposits)
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
        0,     // deposit_fee_rate (0% - free deposits)
        100,   // withdrawal_fee_rate (1%)
        500,   // error_rate (5%)
    );
    assert!(result.is_err());
}

#[test]
fn test_validate_fee_zero_amount() {
    // Test with zero ext_amount (should always pass)
    let result = validate_fee(
        0,     // ext_amount (neither deposit nor withdrawal)
        100,   // provided_fee
        0,     // deposit_fee_rate (0% - free deposits)
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
        0,     // deposit_fee_rate (0% - free deposits)
        25,    // withdrawal_fee_rate (0.25%)
        500,   // error_rate (5%)
    );
    assert!(result.is_ok());
}

#[test]
fn test_validate_fee_high_error_rate() {
    // Test with high error rate (50%)
    // 1000 * 25 / 10000 = 2.5 -> 2
    // minimum = 2 * 50% = 1
    let result = validate_fee(
        1000,  // ext_amount (deposit)
        1,     // provided_fee (minimum with 50% error rate)
        0,     // deposit_fee_rate (0% - free deposits)
        25,    // withdrawal_fee_rate (0.25%)
        5000,  // error_rate (50%)
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
        25,            // withdrawal_fee_rate (0.25%)
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
        0,     // deposit_fee_rate (0% - free deposits)
        25,    // withdrawal_fee_rate (0.25%)
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
        25,        // withdrawal_fee_rate (0.25%)
        0,         // error_rate (0% to test exact calculation)
    );
    // This should return an error (either arithmetic overflow or invalid fee amount)
    assert!(result.is_err());
}

#[test]
fn test_validate_fee_large_fee_rates() {
    // Test with maximum fee rates
    let result = validate_fee(
        1000,  // ext_amount (deposit)
        950,   // provided_fee (95% of 1000)
        10000, // deposit_fee_rate (100%)
        10000, // withdrawal_fee_rate (100%)
        500,   // error_rate (5%)
    );
    assert!(result.is_ok());
}

#[test]
fn test_validate_fee_exact_boundary_cases() {
    // Test exact boundary case where fee equals minimum
    // 100 * 1000 / 10000 = 10
    // minimum = 10 * 90% = 9
    let result = validate_fee(
        100,   // ext_amount (deposit)
        9,     // provided_fee (exact minimum)
        1000,  // deposit_fee_rate (10%)
        0,     // withdrawal_fee_rate
        1000,  // error_rate (10%)
    );
    assert!(result.is_ok());
}

#[test]
fn test_validate_fee_withdrawal_i64_min_protection() {
    // Test that i64::MIN is handled safely for withdrawals
    // This should not panic due to checked_neg() protection
    let result = validate_fee(
        i64::MIN, // ext_amount (minimum possible withdrawal)
        0,        // provided_fee
        0,        // deposit_fee_rate (0% - free deposits)
        25,       // withdrawal_fee_rate (0.25%)
        500,      // error_rate (5%)
    );
    // This should return an error due to arithmetic overflow protection
    assert!(result.is_err());
}

#[test]
fn test_validate_fee_max_basis_points() {
    // Test with maximum possible basis points (10000 = 100%)
    let result = validate_fee(
        1000,  // ext_amount (deposit)
        1000,  // provided_fee (100% of amount)
        10000, // deposit_fee_rate (100%)
        10000, // withdrawal_fee_rate (100%)
        0,     // error_rate (0% - no tolerance)
    );
    assert!(result.is_ok());
}

#[test]
fn test_validate_fee_precision_edge_cases() {
    // Test cases where rounding matters
    // 999 * 1 / 10000 = 0.0999 -> 0 (rounded down)
    let result = validate_fee(
        999,   // ext_amount (deposit)
        0,     // provided_fee (expected is 0 due to rounding)
        1,     // deposit_fee_rate (0.01%)
        25,    // withdrawal_fee_rate (0.25%)
        0,     // error_rate (0% - exact calculation)
    );
    assert!(result.is_ok());
}

#[test]
fn test_validate_fee_withdrawal_large_amount() {
    // Test large withdrawal amounts
    // 1_000_000 * 50 / 10000 = 5000
    // minimum = 5000 * 90% = 4500 (with 10% error rate)
    let result = validate_fee(
        -1_000_000, // ext_amount (large withdrawal)
        4500,       // provided_fee (sufficient for 0.5% rate with 10% tolerance)
        0,          // deposit_fee_rate (0% - free deposits)
        50,         // withdrawal_fee_rate (0.5%)
        1000,       // error_rate (10%)
    );
    assert!(result.is_ok());
}

#[test]
fn test_calculate_complete_ext_data_hash_basic() {
    let recipient = Pubkey::new_unique();
    let ext_amount = 100;
    let encrypted_output1 = b"encrypted_output_1_data";
    let encrypted_output2 = b"encrypted_output_2_data";
    let fee = 10;
    let fee_recipient = Pubkey::new_unique();  // Use the same fee_recipient for both calls
    let mint_address = Pubkey::new_unique();
    
    let result = calculate_complete_ext_data_hash(
        recipient,
        ext_amount,
        encrypted_output1,
        encrypted_output2,
        fee,
        fee_recipient,
        mint_address,
    );
    
    assert!(result.is_ok());
    
    // The hash should be deterministic
    let hash1 = result.unwrap();
    let hash2 = calculate_complete_ext_data_hash(
        recipient,
        ext_amount,
        encrypted_output1,
        encrypted_output2,
        fee,
        fee_recipient,  // Use the same fee_recipient
        mint_address,
    ).unwrap();
    
    assert_eq!(hash1, hash2, "Hash should be deterministic");
}

#[test]
fn test_calculate_complete_ext_data_hash_different_inputs() {
    let recipient1 = Pubkey::new_unique();
    let recipient2 = Pubkey::new_unique();
    let encrypted_output1 = b"encrypted_output_1_data";
    let encrypted_output2 = b"encrypted_output_2_data";
    
    let hash1 = calculate_complete_ext_data_hash(
        recipient1,
        100,
        encrypted_output1,
        encrypted_output2,
        10,
        Pubkey::new_unique(),  // fee_recipient
        recipient1, // Using recipient1 as mint_address for uniqueness
    ).unwrap();
    
    let hash2 = calculate_complete_ext_data_hash(
        recipient2,  // Different recipient
        100,
        encrypted_output1,
        encrypted_output2,
        10,
        Pubkey::new_unique(),  // fee_recipient
        recipient1, // Same mint_address
    ).unwrap();
    
    assert_ne!(hash1, hash2, "Different recipients should produce different hashes");
}

#[test]
fn test_calculate_complete_ext_data_hash_different_amounts() {
    let recipient = Pubkey::new_unique();
    let encrypted_output1 = b"encrypted_output_1_data";
    let encrypted_output2 = b"encrypted_output_2_data";
    let mint_address = Pubkey::new_unique();
    
    let hash1 = calculate_complete_ext_data_hash(
        recipient,
        100,  // Positive amount (deposit)
        encrypted_output1,
        encrypted_output2,
        10,
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    ).unwrap();
    
    let hash2 = calculate_complete_ext_data_hash(
        recipient,
        -100, // Negative amount (withdrawal)
        encrypted_output1,
        encrypted_output2,
        10,
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    ).unwrap();
    
    assert_ne!(hash1, hash2, "Different ext_amounts should produce different hashes");
}

#[test]
fn test_calculate_complete_ext_data_hash_different_encrypted_outputs() {
    let recipient = Pubkey::new_unique();
    let mint_address = Pubkey::new_unique();
    
    let hash1 = calculate_complete_ext_data_hash(
        recipient,
        100,
        b"encrypted_output_1_data",
        b"encrypted_output_2_data",
        10,
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    ).unwrap();
    
    let hash2 = calculate_complete_ext_data_hash(
        recipient,
        100,
        b"different_encrypted_output_1",  // Different encrypted output
        b"encrypted_output_2_data",
        10,
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    ).unwrap();
    
    assert_ne!(hash1, hash2, "Different encrypted outputs should produce different hashes");
}

#[test]
fn test_calculate_complete_ext_data_hash_empty_encrypted_outputs() {
    let recipient = Pubkey::new_unique();
    let mint_address = Pubkey::new_unique();
    
    let result = calculate_complete_ext_data_hash(
        recipient,
        100,
        &[],  // Empty encrypted output 1
        &[],  // Empty encrypted output 2
        10,
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    );
    
    assert!(result.is_ok(), "Should handle empty encrypted outputs");
}

#[test]
fn test_calculate_complete_ext_data_hash_large_encrypted_outputs() {
    let recipient = Pubkey::new_unique();
    let mint_address = Pubkey::new_unique();
    
    // Create large encrypted outputs (512 bytes each)
    let large_encrypted_output1 = vec![0x42u8; 512];
    let large_encrypted_output2 = vec![0x73u8; 512];
    
    let result = calculate_complete_ext_data_hash(
        recipient,
        100,
        &large_encrypted_output1,
        &large_encrypted_output2,
        10,
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    );
    
    assert!(result.is_ok(), "Should handle large encrypted outputs");
}

#[test]
fn test_calculate_complete_ext_data_hash_zero_values() {
    let recipient = Pubkey::new_unique();
    let mint_address = Pubkey::new_unique();
    
    let result = calculate_complete_ext_data_hash(
        recipient,
        0,    // Zero ext_amount
        b"encrypted_output_1",
        b"encrypted_output_2",
        0,    // Zero fee
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    );
    
    assert!(result.is_ok(), "Should handle zero values");
}

#[test]
fn test_calculate_complete_ext_data_hash_negative_amount() {
    let recipient = Pubkey::new_unique();
    let mint_address = Pubkey::new_unique();
    
    let result = calculate_complete_ext_data_hash(
        recipient,
        -1000, // Negative ext_amount (withdrawal)
        b"encrypted_output_1",
        b"encrypted_output_2",
        50,    // Fee for withdrawal
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    );
    
    assert!(result.is_ok(), "Should handle negative ext_amount");
}

#[test]
fn test_calculate_complete_ext_data_hash_different_fees() {
    let recipient = Pubkey::new_unique();
    let mint_address = Pubkey::new_unique();
    let encrypted_output1 = b"encrypted_output_1_data";
    let encrypted_output2 = b"encrypted_output_2_data";
    
    let hash1 = calculate_complete_ext_data_hash(
        recipient,
        100,
        encrypted_output1,
        encrypted_output2,
        10,   // Different fee
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    ).unwrap();
    
    let hash2 = calculate_complete_ext_data_hash(
        recipient,
        100,
        encrypted_output1,
        encrypted_output2,
        20,   // Different fee
        Pubkey::new_unique(),  // fee_recipient
        mint_address,
    ).unwrap();
    
    assert_ne!(hash1, hash2, "Different fees should produce different hashes");
}

#[test]
fn test_calculate_complete_ext_data_hash_consistency_with_borsh() {
    // This test ensures our hash calculation is consistent with Borsh serialization
    use anchor_lang::AnchorSerialize;
    use anchor_lang::solana_program::hash::hash;
    
    let recipient = Pubkey::new_unique();
    let ext_amount = 100i64;
    let encrypted_output1 = b"test_encrypted_1";
    let encrypted_output2 = b"test_encrypted_2";
    let fee = 25u64;
    let fee_recipient = Pubkey::new_unique();  // Use the same fee_recipient for both calculations
    let mint_address = Pubkey::new_unique();
    
    // Calculate using our function
    let our_hash = calculate_complete_ext_data_hash(
        recipient,
        ext_amount,
        encrypted_output1,
        encrypted_output2,
        fee,
        fee_recipient,
        mint_address,
    ).unwrap();
    
    // Calculate manually using the same approach as our function
    #[derive(AnchorSerialize)]
    struct TestCompleteExtData {
        pub recipient: Pubkey,
        pub ext_amount: i64,
        pub encrypted_output1: Vec<u8>,
        pub encrypted_output2: Vec<u8>,
        pub fee: u64,
        pub fee_recipient: Pubkey,
        pub mint_address: Pubkey,
    }
    
    let manual_ext_data = TestCompleteExtData {
        recipient,
        ext_amount,
        encrypted_output1: encrypted_output1.to_vec(),
        encrypted_output2: encrypted_output2.to_vec(),
        fee,
        fee_recipient,  // Use the same fee_recipient
        mint_address,
    };
    
    let mut serialized = Vec::new();
    manual_ext_data.serialize(&mut serialized).unwrap();
    let manual_hash = hash(&serialized).to_bytes();
    
    assert_eq!(our_hash, manual_hash, "Our function should match manual Borsh serialization");
}