import fileVectorsFile from './test-vectors-file-v1.json' with { type: 'json' };
import vectorsFile from './test-vectors-v1.json' with { type: 'json' };

export const TEST_VECTORS_RAW: unknown = vectorsFile.vectors;

export const TEST_VECTORS_FILE_RAW: unknown = fileVectorsFile.vectors;

const v = vectorsFile.vectors;
const f = fileVectorsFile.vectors;

export const V1_HKDF = {
  secretHex: v.v1_hkdf_derivation.secret_hex,
  roomIdHex: v.v1_hkdf_derivation.outputs.roomId_hex,
  handshakeKeyHex: v.v1_hkdf_derivation.outputs.handshake_key_hex,
  sasAnchorHex: v.v1_hkdf_derivation.outputs.sas_anchor_hex,
  storageKey: v.v1_hkdf_derivation.outputs.storageKey_b64url,
  lockKey: v.v1_hkdf_derivation.outputs.lockKey_b64url,
  prfSaltHex: v.v1_hkdf_derivation.outputs.prf_salt_hex,
  opfsDir: v.v1_hkdf_derivation.outputs.opfs_dir_b64url,
} as const;

export const V2_X25519 = {
  alicePrivHex: v.v2_x25519.alice_priv_hex,
  alicePubHex: v.v2_x25519.alice_pub_hex,
  bobPrivHex: v.v2_x25519.bob_priv_hex,
  bobPubHex: v.v2_x25519.bob_pub_hex,
  sharedSecretHex: v.v2_x25519.shared_secret_hex,
} as const;

export const V3_SESSION_KEY = {
  transcriptFirstPubHex: v.v3_session_key.transcript_first_pub_hex,
  transcriptSecondPubHex: v.v3_session_key.transcript_second_pub_hex,
  infoPrefix: v.v3_session_key.info_prefix,
  sessionKeyHex: v.v3_session_key.session_key_hex,
} as const;

export const V4_SAS = {
  info: v.v4_sas_bytes.info,
  length: v.v4_sas_bytes.length,
  sasBytesHex: v.v4_sas_bytes.sas_bytes_hex,
  sasEmojiIndices: v.v4_sas_bytes.sas_emoji_indices as readonly number[],
} as const;

export const V5_AES_GCM = {
  nonceHex: v.v5_aes_gcm_message.nonce_hex,
  aadUtf8: v.v5_aes_gcm_message.aad_utf8,
  aadHex: v.v5_aes_gcm_message.aad_hex,
  plaintextUtf8: v.v5_aes_gcm_message.plaintext_utf8,
  plaintextHex: v.v5_aes_gcm_message.plaintext_hex,
  ciphertextHex: v.v5_aes_gcm_message.ciphertext_hex,
  authTagHex: v.v5_aes_gcm_message.auth_tag_hex,
} as const;

export const V6_WIRE = {
  typeByteHex: v.v6_wire_format.type_byte_hex,
  kindByteHex: v.v6_wire_format.kind_byte_hex,
  ctLenHexLe: v.v6_wire_format.ct_len_hex_le,
  fullFrameHex: v.v6_wire_format.full_frame_hex,
  fullFrameLengthBytes: v.v6_wire_format.full_frame_length_bytes,
} as const;

export const V7_HANDSHAKE_ENCRYPT = {
  nonceHex: v.v7_handshake_encrypt.nonce_hex,
  aadUtf8: v.v7_handshake_encrypt.aad_utf8,
  aadHex: v.v7_handshake_encrypt.aad_hex,
  plaintextHex: v.v7_handshake_encrypt.plaintext_hex,
  ciphertextHex: v.v7_handshake_encrypt.ciphertext_hex,
  ciphertextLengthBytes: v.v7_handshake_encrypt.ciphertext_length_bytes,
  authTagHex: v.v7_handshake_encrypt.auth_tag_hex,
} as const;

export const V8_WRAP_KEY = {
  prfOutputHex: v.v8_wrap_key_derivation.prf_output_hex,
  infoPrefixUtf8: v.v8_wrap_key_derivation.info_prefix_utf8,
  infoPrefixHex: v.v8_wrap_key_derivation.info_prefix_hex,
  infoHex: v.v8_wrap_key_derivation.info_hex,
  infoLengthBytes: v.v8_wrap_key_derivation.info_length_bytes,
  wrapKeyLength: v.v8_wrap_key_derivation.wrap_key_length,
  wrapKeyHex: v.v8_wrap_key_derivation.wrap_key_hex,
} as const;

export const V9_CHUNK_AEAD = {
  nonceHex: f.v9_chunk_aead.nonce_hex,
  aadHex: f.v9_chunk_aead.aad_hex,
  tidHex: f.v9_chunk_aead.tid_hex,
  seq: f.v9_chunk_aead.seq,
  seqHexLe: f.v9_chunk_aead.seq_hex_le,
  dataHex: f.v9_chunk_aead.data_hex,
  dataLengthBytes: f.v9_chunk_aead.data_length_bytes,
  plaintextHex: f.v9_chunk_aead.plaintext_hex,
  plaintextLengthBytes: f.v9_chunk_aead.plaintext_length_bytes,
  ciphertextHex: f.v9_chunk_aead.ciphertext_hex,
  ciphertextLengthBytes: f.v9_chunk_aead.ciphertext_length_bytes,
  authTagHex: f.v9_chunk_aead.auth_tag_hex,
} as const;

export const V10_AAD_BINDING = {
  sharedNonceHex: f.v10_aad_binding.shared_nonce_hex,
  sharedPlaintextHex: f.v10_aad_binding.shared_plaintext_hex,
  aadMsgHex: f.v10_aad_binding.aad_msg_hex,
  aadChunkHex: f.v10_aad_binding.aad_chunk_hex,
  ciphertextUnderMsgAadHex: f.v10_aad_binding.ciphertext_under_msg_aad_hex,
  ciphertextUnderChunkAadHex: f.v10_aad_binding.ciphertext_under_chunk_aad_hex,
} as const;

export const V11_REKEY = {
  initiatorPrivHex: v.v11_rekeyed_session_key.initiator_priv_hex,
  initiatorPubHex: v.v11_rekeyed_session_key.initiator_pub_hex,
  joinerPrivHex: v.v11_rekeyed_session_key.joiner_priv_hex,
  joinerPubHex: v.v11_rekeyed_session_key.joiner_pub_hex,
  sharedSecretHex: v.v11_rekeyed_session_key.shared_secret_hex,
  rekeyedSessionKeyHex: v.v11_rekeyed_session_key.rekeyed_session_key_hex,
} as const;
