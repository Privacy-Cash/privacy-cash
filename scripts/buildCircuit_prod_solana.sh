#!/bin/bash -e
# Circuit Builder for Solana (Production Version)
# Adapted from Tornado Cash Nova

# Configuration
POWERS_OF_TAU=18 # circuit will support max 2^POWERS_OF_TAU constraints
CIRCUIT_DIR="../circuits"
ARTIFACTS_DIR="../artifacts/circuits"

# Create necessary directories
mkdir -p $ARTIFACTS_DIR
mkdir -p $CIRCUIT_DIR

# Define the Powers of Tau filename correctly
PTAU_FILE="powersOfTau28_hez_final_${POWERS_OF_TAU}.ptau"

# Download Powers of Tau file if not exists
if [ ! -f "$ARTIFACTS_DIR/$PTAU_FILE" ]; then
    echo "Downloading powers of tau file"
    # Try alternative sources since the original one might return 403
    echo "Trying Google Storage source..."
    curl -L "https://storage.googleapis.com/zkevm/ptau/$PTAU_FILE" --create-dirs -o "$ARTIFACTS_DIR/$PTAU_FILE"
    # Check if download was successful
    if [ ! -s "$ARTIFACTS_DIR/$PTAU_FILE" ]; then
        echo "Google Storage source failed, trying Dropbox source..."
        curl -L "https://www.dropbox.com/scl/fi/e3ul8p3c9b8dv7a6o2oit/powersOfTau28_hez_final_18.ptau?rlkey=yjjw5f2h0vbxvp0uf0xt0wnfn&dl=1" -o "$ARTIFACTS_DIR/$PTAU_FILE"
    fi
    # Verify file was downloaded successfully
    if [ ! -s "$ARTIFACTS_DIR/$PTAU_FILE" ]; then
        echo "Error: Failed to download Powers of Tau file. Please download it manually."
        echo "You can try: curl -L https://storage.googleapis.com/zkevm/ptau/$PTAU_FILE -o $ARTIFACTS_DIR/$PTAU_FILE"
        exit 1
    fi
fi

# Check if circuit number is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <circuit_number>"
    echo "Example: $0 2 (for transaction2.circom) "
    exit 1
fi

# Ensure the circuit file exists
if [ ! -f "$CIRCUIT_DIR/transaction$1.circom" ]; then
    echo "Error: Circuit file $CIRCUIT_DIR/transaction$1.circom not found"
    echo "Please ensure your circuit files are in the $CIRCUIT_DIR directory"
    exit 1
fi

echo "===== Circuit Builder for Solana ====="
echo "Building circuit: transaction$1.circom"
echo "==============================================="

# Compile the circuit
echo "[1/3] Compiling circuit transaction$1.circom..."
# Fix the circom command with correct paths
circom --r1cs --wasm --sym "$CIRCUIT_DIR/transaction$1.circom" -o "$ARTIFACTS_DIR" -l "../scripts/node_modules/circomlib/circuits"

# Add after the circom command in buildCircuit_prod_solana.sh
cp "$ARTIFACTS_DIR/transaction$1_js/transaction$1.wasm" "$ARTIFACTS_DIR/"

echo "✅ Circuit compilation complete"

# Setup the circuit
echo "[2/3] Setting up the circuit..."
npx snarkjs groth16 setup "$ARTIFACTS_DIR/transaction$1.r1cs" "$ARTIFACTS_DIR/$PTAU_FILE" "$ARTIFACTS_DIR/transaction$1_0.zkey"
echo "✅ Circuit setup complete"

# Contribute to the ceremony
echo "[3/3] Contributing to the ceremony..."
echo "Ceremony Contribution" | npx snarkjs zkey contribute "$ARTIFACTS_DIR/transaction$1_0.zkey" "$ARTIFACTS_DIR/transaction$1.zkey"
echo "✅ Contribution complete"

# Convert zkey to json
npx snarkjs zkey export verificationkey "$ARTIFACTS_DIR/transaction$1.zkey" "$ARTIFACTS_DIR/verifyingkey$1.json"
echo "✅ Zkey export complete"

# Print circuit info
echo "📊 Circuit information:"
npx snarkjs info -r "$ARTIFACTS_DIR/transaction$1.r1cs"

echo "🎉 Solana Circuit Build Completed Successfully! 🎉"
echo "Artifacts are available in $ARTIFACTS_DIR/"
echo "- R1CS: $ARTIFACTS_DIR/transaction$1.r1cs"
echo "- WASM: $ARTIFACTS_DIR/transaction$1.wasm"
echo "- SYM: $ARTIFACTS_DIR/transaction$1.sym"
echo "- ZKEY: $ARTIFACTS_DIR/transaction$1.zkey"
echo "- VERIFICATION KEY: $ARTIFACTS_DIR/transaction$1.json"
