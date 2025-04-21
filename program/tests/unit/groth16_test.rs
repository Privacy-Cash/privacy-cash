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
		30,95,225,189,58,237,101,131,127,88,158,133,19,64,106,156,166,246,7,179,53,34,110,53,28,208,113,11,142,198,186,113,
		28,31,107,27,59,253,35,242,51,140,225,214,130,204,63,90,203,70,227,96,113,221,51,31,167,60,186,59,202,201,19,173,
		4,31,69,241,223,20,23,15,221,9,182,153,73,7,161,109,74,181,163,40,188,56,164,34,139,222,103,206,215,210,205,43,
		7,216,141,121,126,65,33,154,20,31,197,189,114,211,92,12,146,158,113,45,81,18,60,117,181,208,38,181,142,80,86,14,
	],

	vk_ic: &[
		[
			29,49,176,245,76,173,145,182,194,195,3,213,104,77,146,185,101,234,239,93,12,194,136,117,1,216,161,230,141,71,31,51,
			2,63,125,130,181,241,71,199,34,187,28,137,39,43,118,183,54,62,58,16,145,70,127,169,177,50,252,135,37,174,232,241,
		],
		[
			36,150,101,54,11,195,226,127,175,41,110,231,199,166,155,29,146,82,67,94,20,189,21,212,223,228,35,14,133,250,177,45,
			31,178,20,31,176,148,237,204,187,221,99,63,108,239,104,76,141,128,211,163,201,22,129,210,191,187,16,0,0,102,235,9,
		],
		[
			48,18,85,186,219,119,255,103,253,232,162,66,9,245,86,28,94,197,73,24,53,73,141,33,119,38,87,231,80,195,107,82,
			30,87,223,14,140,72,189,180,55,220,48,197,249,232,219,151,119,237,147,169,193,34,211,154,99,66,1,253,149,132,154,134,
		],
		[
			27,240,132,166,96,203,28,251,212,149,191,99,220,186,129,64,21,195,159,195,83,88,155,53,222,190,157,85,36,100,235,163,
			45,56,133,28,136,16,152,23,201,29,130,120,226,88,253,179,80,107,108,118,1,0,162,73,251,134,180,128,105,206,159,235,
		],
		[
			25,113,36,2,238,54,203,35,169,53,65,15,184,117,226,5,199,117,107,75,63,218,164,62,236,248,240,238,89,4,189,251,
			42,43,134,65,95,224,94,252,241,233,138,80,137,157,244,183,166,185,85,127,59,62,93,183,225,188,98,111,62,62,39,123,
		],
		[
			4,136,164,246,154,196,146,253,101,122,85,215,224,190,210,98,111,127,229,86,226,111,71,80,244,97,112,202,28,58,168,224,
			17,100,164,97,156,162,156,114,197,163,41,15,44,140,177,92,168,170,201,208,19,59,94,148,31,222,171,41,47,216,168,223,
		],
		[
			43,182,211,90,3,205,61,31,27,126,24,238,150,3,246,174,27,83,120,52,145,97,202,178,88,240,92,204,0,218,116,218,
			7,253,117,67,60,191,26,21,17,243,242,113,120,189,68,226,123,185,238,240,158,237,61,182,185,188,79,135,122,222,139,117,
		],
		[
			39,162,221,201,103,38,234,129,65,178,194,87,170,62,127,229,94,204,123,135,164,254,114,189,179,23,229,211,235,145,19,93,
			6,180,230,138,43,247,140,115,212,39,215,113,124,130,24,41,35,74,98,188,67,249,112,106,98,149,91,252,25,221,138,164,
		],
	]
};

pub const PROOF_A: [u8; 64] = [39,99,250,229,222,189,181,234,192,49,101,11,83,236,75,96,129,253,135,143,175,138,226,141,119,210,125,15,96,64,147,175,38,253,175,147,16,159,91,7,85,178,97,124,24,103,0,23,206,241,148,137,196,9,203,25,27,237,11,175,108,215,176,74];

pub const PROOF_B: [u8; 128] = [6,114,224,206,200,123,88,110,110,220,33,14,218,110,82,234,163,166,210,211,125,164,150,245,60,233,227,39,77,95,205,62,40,226,28,64,122,113,154,9,135,12,191,157,94,26,160,113,8,236,227,76,122,175,215,185,66,113,50,251,184,156,37,240,22,39,243,60,213,235,14,172,83,156,238,147,143,115,105,128,208,231,23,225,81,112,253,120,239,236,191,231,90,62,156,76,47,30,103,168,247,100,51,96,190,216,248,206,154,96,174,235,123,142,184,21,150,160,188,154,72,188,29,53,73,201,139,164];

pub const PROOF_C: [u8; 64] = [26,115,217,214,87,70,7,230,7,81,162,136,115,118,90,103,239,154,130,213,113,140,122,121,202,245,182,1,99,216,95,148,2,232,100,86,194,106,189,7,190,90,35,7,153,112,224,122,254,60,180,189,22,205,154,5,149,134,194,162,55,208,51,3];

pub const PUBLIC_INPUTS: [[u8; 32]; 7] = [
    [32,239,172,80,106,84,86,138,69,179,67,158,237,230,87,94,165,43,236,22,252,117,87,47,222,165,74,177,254,110,111,37],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,89,104,47,0],
    [28,204,235,186,233,206,245,116,226,86,7,174,38,249,180,110,37,60,216,60,147,170,154,177,233,34,238,168,38,103,184,231],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,119,53,158,65],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,59,154,212,66],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,232,117,81,65],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,59,154,212,65]
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
