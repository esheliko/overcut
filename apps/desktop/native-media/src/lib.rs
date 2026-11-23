//! Desktop media (S4 / M1-015): libav behind the engine's own traits.
//!
//! * [`LibavHost`] implements `app_media::PacketDecoder`. Rust (`HostDecoder`) plans which packets to feed, exactly as on the web; this
//!   host reads the packet bytes from the file, runs a libav codec and returns RGBA / f32 PCM. Same demuxer, same frame selection.
//! * [`Mp4Encoder`] encodes RGBA frames + f32 audio to H.264 + AAC in MP4, preferring hardware encoders (see [`H264_PREFERENCE`]).
//!
//! Licence policy (ADR 0004, 0009): libav is linked **dynamically** and only LGPL parts are used by default. No x264/x265/FDK-AAC is
//! ever named in [`H264_PREFERENCE`]; software H.264 is `libopenh264`. Tests may pass extra encoder names for a dev libav build.
#![allow(clippy::too_many_arguments)]

mod decode;
mod encode;

pub use decode::{open_file, LibavHost};
pub use encode::{encoder_available, EncoderConfig, ExportStats, Mp4Encoder, H264_PREFERENCE};

/// Initialises libav once (idempotent, silences its logging below warnings).
pub fn init() -> Result<(), String> {
    ffmpeg_next::init().map_err(|e| e.to_string())?;
    ffmpeg_next::util::log::set_level(ffmpeg_next::util::log::Level::Error);
    Ok(())
}
