use zkcash::lib::groth16::{Groth16Verifier, Groth16Verifyingkey, is_less_than_bn254_field_size_be};
use zkcash::errors::Groth16Error;
use ark_bn254;
use ark_ff::PrimeField;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use std::ops::Neg;
use num_bigint::BigUint;
type G1 = ark_bn254::g1::G1Affine;
type G2 = ark_bn254::g2::G2Affine;
use solana_bn254::compression::prelude::convert_endianness;

// Define constants needed for tests
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

pub const PROOF_A: [u8; 64] = [39,99,250,229,222,189,181,234,192,49,101,11,83,236,75,96,129,253,135,143,175,138,226,141,119,210,125,15,96,64,147,175,38,253,175,147,16,159,91,7,85,178,97,124,24,103,0,23,206,241,148,137,196,9,203,25,27,237,11,175,108,215,176,74];

pub const PROOF_B: [u8; 128] = [6,114,224,206,200,123,88,110,110,220,33,14,218,110,82,234,163,166,210,211,125,164,150,245,60,233,227,39,77,95,205,62,40,226,28,64,122,113,154,9,135,12,191,157,94,26,160,113,8,236,227,76,122,175,215,185,66,113,50,251,184,156,37,240,22,39,243,60,213,235,14,172,83,156,238,147,143,115,105,128,208,231,23,225,81,112,253,120,239,236,191,231,90,62,156,76,47,30,103,168,247,100,51,96,190,216,248,206,154,96,174,235,123,142,184,21,150,160,188,154,72,188,29,53,73,201,139,164];

pub const PROOF_C: [u8; 64] = [26,115,217,214,87,70,7,230,7,81,162,136,115,118,90,103,239,154,130,213,113,140,122,121,202,245,182,1,99,216,95,148,2,232,100,86,194,106,189,7,190,90,35,7,153,112,224,122,254,60,180,189,22,205,154,5,149,134,194,162,55,208,51,3];

pub const PUBLIC_INPUTS: [[u8; 32]; 7] = [
    [
      36, 177,  82,  77, 209, 248,  53, 216,
      87,  46,  36, 166,  31, 199,   8,  95,
      19, 241, 172,   1, 145, 192, 219, 153,
      41, 133,  14, 203, 232,   9, 211, 172
    ],
    [
      0,   0,   0,   0, 0, 0, 0, 0, 0,
      0,   0,   0,   0, 0, 0, 0, 0, 0,
      0,   0,   0,   0, 0, 0, 0, 0, 0,
      0, 172, 218, 125, 0
    ],
    [
        2, 245,  48,  87,  24,  45, 182, 170,
      210, 245, 181, 171, 138, 109, 150, 239,
       58, 236,  29, 113, 123, 244, 146,  81,
      114, 173, 104, 158, 111,  64,  57, 196
    ],
    [
       19,  49,  34, 145, 196, 178,  65,  48,
       82, 144, 246, 208,  70,   8,  44,  49,
      249, 224, 214,  17, 217, 247, 243, 127,
      169, 139, 107, 165,   4,  71, 163, 199
    ],
    [
       16,  54, 223,  67, 194, 129, 223,
      156, 138, 222,  68,  78,  78, 134,
      230, 170, 163, 121, 148,  96, 167,
      158, 222, 223, 192, 136, 226, 252,
      123, 133, 172, 198
    ],
    [
       48,   3, 195, 130, 250, 237, 171,  57,
       47, 116, 118, 204, 128, 119,  77,  94,
       99, 138, 229,  51, 214, 115,  44,  15,
      125, 212, 114, 208, 103, 162, 227, 192
    ],
    [
       23, 216,  99, 134, 148, 224,  19,
      162, 214, 155, 237, 245,  86, 229,
      238, 139, 204, 235, 234, 196, 225,
       98, 249,  88, 115, 201, 106, 221,
      225, 154, 206, 187
    ]
  ];

fn change_endianness(bytes: &[u8]) -> Vec<u8> {
    let mut vec = Vec::new();
    for b in bytes.chunks(32) {
        for byte in b.iter().rev() {
            vec.push(*byte);
        }
    }
    vec
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
    // Construct the verifier
    let mut verifier =
        Groth16Verifier::new(&PROOF_A, &PROOF_B, &PROOF_C, &PUBLIC_INPUTS, &VERIFYING_KEY)
            .unwrap();
    
    verifier.verify().unwrap();
    verifier.verify_unchecked().unwrap();
}

#[test]
fn proof_verification_with_compressed_inputs_should_succeed() {
    let mut public_inputs_vec = Vec::new();
    for input in PUBLIC_INPUTS.chunks(32) {
        public_inputs_vec.push(input);
    }
    let compressed_proof_a = compress_g1_be(&PROOF_A.try_into().unwrap());
    let compressed_proof_b = compress_g2_be(&PROOF_B.try_into().unwrap());
    let compressed_proof_c = compress_g1_be(&PROOF_C.try_into().unwrap());

    let proof_a = decompress_g1(&compressed_proof_a).unwrap();
    let proof_a: G1 = G1::deserialize_with_mode(
        &*[&change_endianness(&proof_a[0..64]), &[0u8][..]].concat(),
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
    let proof_b = decompress_g2(&compressed_proof_b).unwrap();
    let proof_c = decompress_g1(&compressed_proof_c).unwrap();
    
    // Construct the verifier
    let mut verifier =
        Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &PUBLIC_INPUTS, &VERIFYING_KEY)
            .unwrap();
    
    verifier.verify().unwrap();
    verifier.verify_unchecked().unwrap();
}

#[test]
fn wrong_proof_verification_should_not_succeed() {
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

// #[test]
// fn public_input_greater_than_field_size_should_not_suceed() {
//     let proof_a: G1 = G1::deserialize_with_mode(
//         &*[&change_endianness(&PROOF[0..64]), &[0u8][..]].concat(),
//         Compress::No,
//         Validate::Yes,
//     )
//     .unwrap();
//     let mut proof_a_neg = [0u8; 65];
//     proof_a
//         .neg()
//         .x
//         .serialize_with_mode(&mut proof_a_neg[..32], Compress::No)
//         .unwrap();
//     proof_a
//         .neg()
//         .y
//         .serialize_with_mode(&mut proof_a_neg[32..], Compress::No)
//         .unwrap();

//     let proof_a = change_endianness(&proof_a_neg[..64]).try_into().unwrap();
//     let proof_b = PROOF[64..192].try_into().unwrap();
//     let proof_c = PROOF[192..256].try_into().unwrap();
    
//     let mut public_inputs = PUBLIC_INPUTS;
//     public_inputs[0] = BigUint::from(ark_bn254::Fr::MODULUS)
//         .to_bytes_be()
//         .try_into()
//         .unwrap();
//     let mut verifier = Groth16Verifier::new(
//         &proof_a,
//         &proof_b,
//         &proof_c,
//         &public_inputs,
//         &VERIFYING_KEY,
//     )
//     .unwrap();
//     assert_eq!(
//         verifier.verify_unchecked(),
//         Err(Groth16Error::ProofVerificationFailed)
//     );
//     assert_eq!(
//         verifier.verify(),
//         Err(Groth16Error::PublicInputGreaterThanFieldSize)
//     );
// }

fn compress_g1_be(g1: &[u8; 64]) -> [u8; 32] {
    let g1 = convert_endianness::<32, 64>(g1);
    let mut compressed = [0u8; 32];
    let g1 = G1::deserialize_with_mode(g1.as_slice(), Compress::No, Validate::Yes).unwrap();
    G1::serialize_with_mode(&g1, &mut compressed[..], Compress::Yes).unwrap();

    convert_endianness::<32, 32>(&compressed)
}

fn compress_g2_be(g2: &[u8; 128]) -> [u8; 64] {
    let g2: [u8; 128] = convert_endianness::<64, 128>(g2);

    let mut compressed = [0u8; 64];
    let g2 = G2::deserialize_with_mode(g2.as_slice(), Compress::No, Validate::Yes).unwrap();
    G2::serialize_with_mode(&g2, &mut compressed[..], Compress::Yes).unwrap();
    convert_endianness::<64, 64>(&compressed)
}

/// Decompress a compressed G1 point
fn decompress_g1(compressed: &[u8; 32]) -> Result<[u8; 64], &'static str> {
    let compressed = convert_endianness::<32, 32>(compressed);
    
    let g1 = G1::deserialize_with_mode(
        compressed.as_slice(),
        Compress::Yes,
        Validate::Yes,
    )
    .map_err(|_| "Failed to deserialize G1 point")?;
    
    let mut uncompressed = [0u8; 64];
    let mut x_bytes = [0u8; 32];
    let mut y_bytes = [0u8; 32];
    
    g1.x.serialize_with_mode(&mut x_bytes[..], Compress::No)
        .map_err(|_| "Failed to serialize G1 x coordinate")?;
    g1.y.serialize_with_mode(&mut y_bytes[..], Compress::No)
        .map_err(|_| "Failed to serialize G1 y coordinate")?;
    
    uncompressed[..32].copy_from_slice(&x_bytes);
    uncompressed[32..].copy_from_slice(&y_bytes);
    
    let uncompressed = convert_endianness::<32, 64>(&uncompressed);
    Ok(uncompressed)
}

/// Decompress a compressed G2 point
fn decompress_g2(compressed: &[u8; 64]) -> Result<[u8; 128], &'static str> {
    let compressed = convert_endianness::<64, 64>(compressed);
    
    let g2 = G2::deserialize_with_mode(
        compressed.as_slice(),
        Compress::Yes,
        Validate::Yes,
    )
    .map_err(|_| "Failed to deserialize G2 point")?;
    
    let mut uncompressed = [0u8; 128];
    let mut x_bytes = [0u8; 64];
    let mut y_bytes = [0u8; 64];
    
    g2.x.serialize_with_mode(&mut x_bytes[..], Compress::No)
        .map_err(|_| "Failed to serialize G2 x coordinate")?;
    g2.y.serialize_with_mode(&mut y_bytes[..], Compress::No)
        .map_err(|_| "Failed to serialize G2 y coordinate")?;
    
    uncompressed[..64].copy_from_slice(&x_bytes);
    uncompressed[64..].copy_from_slice(&y_bytes);
    
    let uncompressed = convert_endianness::<64, 128>(&uncompressed);
    Ok(uncompressed)
}
