import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';

export const FIELD_SIZE = new BN('21888242871839275222246405745257275088548364400416034343698204186575808495617')

// Fee recipient account for all transactions
export const FEE_RECIPIENT_ACCOUNT = new PublicKey('EjusM5jooQkcfGFWrZPmzw9GeoxFpJKjdsSmHLQe3GYx');