//! Exports for the node runner. Spike code: `unsafe_code` is allowed here only.
use app_model::anim::golden_checksum;

#[no_mangle]
pub extern "C" fn checksum(n: u32) -> u64 {
    golden_checksum(n)
}
