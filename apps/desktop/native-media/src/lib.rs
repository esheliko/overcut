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
mod session;

pub use decode::{block_on, open_file, LibavHost};
pub use encode::{
    encoder_available, AudioConfig, EncoderConfig, ExportStats, Mp4Encoder, H264_PREFERENCE,
};
pub use session::{ExportParams, NativeExport, NativeMedia};

/// Initialises libav once (idempotent, silences its logging below warnings).
pub fn init() -> Result<(), String> {
    ffmpeg_next::init().map_err(|e| e.to_string())?;
    ffmpeg_next::util::log::set_level(ffmpeg_next::util::log::Level::Error);
    Ok(())
}

/// The licence of the libav this process is linked against (`avcodec_license()`): "LGPL version 2.1 or later" is what we ship.
/// A "GPL ..." string means a GPL build (x264 etc.) is loaded: fine for development, never for a release (ADR 0004, S4 results).
pub fn libav_license() -> String {
    // SAFETY: avcodec_license returns a static NUL-terminated string owned by libavcodec.
    unsafe {
        std::ffi::CStr::from_ptr(ffmpeg_next::ffi::avcodec_license())
            .to_string_lossy()
            .into_owned()
    }
}

/// True when the loaded libav is LGPL (not GPL / nonfree).
pub fn libav_is_lgpl() -> bool {
    libav_license().starts_with("LGPL")
}

#[cfg(test)]
mod tests {
    #[test]
    fn preference_list_names_no_gpl_encoder() {
        for n in crate::H264_PREFERENCE {
            assert!(
                !n.contains("x264") && !n.contains("x265") && !n.contains("fdk"),
                "{n}"
            );
        }
        assert_eq!(crate::H264_PREFERENCE.last(), Some(&"libopenh264"));
    }
}
