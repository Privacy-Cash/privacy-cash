use zkcash::groth16::{Groth16Verifier, Groth16Verifyingkey, is_less_than_bn254_field_size_be};
use zkcash::errors::Groth16Error;
use ark_bn254;
use ark_ff::PrimeField;
use ark_bn254::Fr;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use zkcash::utils::{change_endianness, VERIFYING_KEY};
use std::ops::Neg;
use num_bigint::BigUint;
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

    // Construct the verifier
    let mut verifier =
        Groth16Verifier::new(&proof_a, &PROOF_B, &PROOF_C, &PUBLIC_INPUTS, &VERIFYING_KEY)
            .unwrap();
    
    verifier.verify().unwrap();
    verifier.verify_unchecked().unwrap();
}

#[test]
fn non_negated_proof_a_verification_should_not_succeed() {
    let mut verifier = Groth16Verifier::new(
        &PROOF_A, // using non negated proof a as test for wrong proof
        &PROOF_B,
        &PROOF_C,
        &PUBLIC_INPUTS,
        &VERIFYING_KEY,
    )
    .unwrap();
    assert_eq!(
        verifier.verify(),
        Err(Groth16Error::ProofVerificationFailed)
    );
    assert_eq!(
        verifier.verify_unchecked(),
        Err(Groth16Error::ProofVerificationFailed)
    );
}

#[test]
fn wrong_verifying_key_verification_should_not_succeed() {
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

    const WRONG_VERIFYING_KEY: Groth16Verifyingkey =  Groth16Verifyingkey {
        nr_pubinputs: 7,
    
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

    // Construct the verifier
    let mut verifier =
        Groth16Verifier::new(&proof_a, &PROOF_B, &PROOF_C, &PUBLIC_INPUTS, &WRONG_VERIFYING_KEY)
            .unwrap();
    
    assert_eq!(
        verifier.verify(),
        Err(Groth16Error::ProofVerificationFailed)
    );
    assert_eq!(
        verifier.verify_unchecked(),
        Err(Groth16Error::ProofVerificationFailed)
    );
}

#[test]
fn public_input_greater_than_field_size_should_not_suceed() {
    let proof_a: G1 = G1::deserialize_with_mode(
        &*[&change_endianness(&PROOF_A[0..64]), &[0u8][..]].concat(),
        Compress::No,
        Validate::Yes,
    )
    .unwrap();
    let mut proof_a_neg = [0u8; 65];
    proof_a
        .neg()
        .x
        .serialize_with_mode(&mut proof_a_neg[..32], Compress::No)
        .unwrap();
    proof_a
        .neg()
        .y
        .serialize_with_mode(&mut proof_a_neg[32..], Compress::No)
        .unwrap();

    let proof_a = change_endianness(&proof_a_neg[..64]).try_into().unwrap();
    
    let mut public_inputs = PUBLIC_INPUTS;
    public_inputs[0] = BigUint::from(ark_bn254::Fr::MODULUS)
        .to_bytes_be()
        .try_into()
        .unwrap();
    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &PROOF_B,
        &PROOF_C,
        &public_inputs,
        &VERIFYING_KEY,
    )
    .unwrap();
    assert_eq!(
        verifier.verify_unchecked(),
        Err(Groth16Error::ProofVerificationFailed)
    );
    assert_eq!(
        verifier.verify(),
        Err(Groth16Error::PublicInputGreaterThanFieldSize)
    );
} 

#[test]
fn ext_data_hash_should_match() {
    let computed_hash = [114, 47, 77, 7, 112, 57, 94, 210, 93, 75, 192, 50, 183, 228, 5, 111, 228, 58, 178, 60, 144, 169, 10, 46, 109, 93, 171, 65, 192, 33, 201, 204];
    let provided_proof_hash = [11, 55, 231, 244, 188, 228, 220, 198, 76, 201, 146, 182, 54, 172, 217, 111, 206, 54, 67, 149, 75, 218, 137, 24, 194, 214, 99, 32, 71, 77, 47, 110];

    let computed_hash_fr: Fr = Fr::from_le_bytes_mod_order(&computed_hash);
    let provided_proof_hash_fr: Fr = Fr::from_be_bytes_mod_order(&provided_proof_hash);
    
    // Compare field elements with field elements
    assert_eq!(computed_hash_fr, provided_proof_hash_fr);
}