#!/usr/bin/env bash
# Generate a new Bitcoin keypair and print WIF + address for proof-of-reserves.
# Run from repo root: ./website/scripts/generate-btc-key.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$WEBSITE_DIR"
node -e "
const bitcoin = require('bitcoinjs-lib');
const keyPair = bitcoin.ECPair.makeRandom({ network: bitcoin.networks.bitcoin });
const wif = keyPair.toWIF();
const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: bitcoin.networks.bitcoin });
console.log('WIF (private):', wif);
console.log('Address (public):', address);
"
