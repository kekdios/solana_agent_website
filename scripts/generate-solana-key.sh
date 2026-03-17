#!/usr/bin/env bash
# Generate a new Solana keypair and print base58 secret + address for proof-of-reserves.
# Run from repo root: ./website/scripts/generate-solana-key.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$WEBSITE_DIR"
node -e "
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const encode = (bs58 && bs58.default ? bs58.default : bs58).encode;
const kp = Keypair.generate();
const secretBase58 = encode(kp.secretKey);
console.log('Private key (base58):', secretBase58);
console.log('Address (public):', kp.publicKey.toBase58());
"
