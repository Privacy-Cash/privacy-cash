import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  sendAndConfirmTransaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { connection, PROGRAM_ID } from '../config';
import { logger } from '../index';

// Use the same instruction discriminator as deposit
const TRANSACT_IX_DISCRIMINATOR = Buffer.from([217, 149, 130, 143, 221, 52, 252, 119]);

// Interface for withdraw parameters
export interface WithdrawParams {
  serializedProof: string;
  treeAccount: string;
  nullifier0PDA: string;
  nullifier1PDA: string;
  commitment0PDA: string;
  commitment1PDA: string;
  treeTokenAccount: string;
  recipient: string;
  feeRecipientAccount: string;
  deployer: string;
  extAmount: number;
  encryptedOutput1: string; // Base64 encoded
  encryptedOutput2: string; // Base64 encoded
  fee: number;
  extraData?: any;
}

// Load the relayer fee payer keypair
function loadRelayerKeypair(): Keypair {
  const keypairPath = path.resolve(__dirname, '../../relayer_fee_payer_keypair.json');
  
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Relayer keypair not found at ${keypairPath}`);
  }
  
  const keypairData = fs.readFileSync(keypairPath, 'utf8');
  const keypairJson = JSON.parse(keypairData);
  
  // Handle both array format and object format
  const secretKey = Array.isArray(keypairJson) ? keypairJson : keypairJson.secretKey;
  
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

// Get relayer public key
export function getRelayerPublicKey(): PublicKey {
  try {
    const keypair = loadRelayerKeypair();
    return keypair.publicKey;
  } catch (error) {
    logger.error('Failed to load relayer keypair:', error);
    throw error;
  }
}

// Submit withdraw transaction
export async function submitWithdrawTransaction(params: WithdrawParams): Promise<string> {
  try {
    logger.info('Processing withdraw request:', {
      recipient: params.recipient,
      extAmount: params.extAmount,
      fee: params.fee,
      treeAccount: params.treeAccount
    });

    // Load the relayer keypair
    const relayerKeypair = loadRelayerKeypair();
    logger.info('Using relayer:', relayerKeypair.publicKey.toString());

    // Decode the serialized proof from base64
    const serializedProofData = Buffer.from(params.serializedProof, 'base64');
    
    // Create the withdraw instruction using the same pattern as deposit
    const withdrawInstruction = createWithdrawInstruction(params, serializedProofData);

    // Set compute budget for the transaction (needed for complex transactions)
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });

    // Create transaction with compute budget instruction and the main instruction
    const transaction = new Transaction()
      .add(modifyComputeUnits)
      .add(withdrawInstruction);
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = relayerKeypair.publicKey;

    // Sign and send transaction
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [relayerKeypair],
      {
        commitment: 'confirmed',
        maxRetries: 3
      }
    );

    logger.info('Withdraw transaction submitted successfully:', signature);
    return signature;

  } catch (error) {
    logger.error('Failed to submit withdraw transaction:', error);
    throw error;
  }
}

// Create withdraw instruction following the same pattern as deposit
function createWithdrawInstruction(
  params: WithdrawParams,
  serializedProofData: Buffer
): TransactionInstruction {
  // Convert string addresses to PublicKeys
  const treeAccount = new PublicKey(params.treeAccount);
  const nullifier0PDA = new PublicKey(params.nullifier0PDA);
  const nullifier1PDA = new PublicKey(params.nullifier1PDA);
  const commitment0PDA = new PublicKey(params.commitment0PDA);
  const commitment1PDA = new PublicKey(params.commitment1PDA);
  const treeTokenAccount = new PublicKey(params.treeTokenAccount);
  const recipient = new PublicKey(params.recipient);
  const feeRecipientAccount = new PublicKey(params.feeRecipientAccount);
  const deployer = new PublicKey(params.deployer);

  // The serializedProofData should already contain the full instruction data
  // (discriminator + proof + extData) as created by the client
  const instructionData = serializedProofData;

  logger.info(`Using instruction data size: ${instructionData.length} bytes`);

  return new TransactionInstruction({
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: nullifier0PDA, isSigner: false, isWritable: true },
      { pubkey: nullifier1PDA, isSigner: false, isWritable: true },
      { pubkey: commitment0PDA, isSigner: false, isWritable: true },
      { pubkey: commitment1PDA, isSigner: false, isWritable: true },
      { pubkey: treeTokenAccount, isSigner: false, isWritable: true },
      // recipient
      { pubkey: recipient, isSigner: false, isWritable: true },
      // fee recipient
      { pubkey: feeRecipientAccount, isSigner: false, isWritable: true },
      // deployer
      { pubkey: deployer, isSigner: false, isWritable: false },
      // signer (relayer instead of user)
      { pubkey: loadRelayerKeypair().publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: instructionData,
  });
}

// Get relayer balance
export async function getRelayerBalance(): Promise<number> {
  try {
    const keypair = loadRelayerKeypair();
    const balance = await connection.getBalance(keypair.publicKey);
    return balance / 1e9; // Convert lamports to SOL
  } catch (error) {
    logger.error('Failed to get relayer balance:', error);
    throw error;
  }
} 