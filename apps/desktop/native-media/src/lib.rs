//! Desktop media (S4 / M1-015): libav behind the engine's own traits.
//!
//! * [`LibavHost`] implements `app_media::PacketDecoder`. Rust (`HostDecoder`) plans which packets to feed, exactly as on the web; this
//!   host reads the packet bytes from the file, runs a libav codec and returns RGBA / f32 PCM. Same demuxer, same frame selection.
//! * [`MediaEncoder`] encodes RGBA frames + f32 audio to H.264 + AAC in MP4 (hardware encoders first, see [`H264_PREFERENCE`]) or VP9 + Opus in WebM.
//! * [`openh264`]: the opt-in, hash-pinned download of Cisco's software H.264 encoder (issue #57).
//!
//! Licence policy (ADR 0004, 0009): libav is linked **dynamically** and only LGPL parts are used by default. No x264/x265/FDK-AAC is
//! ever named in [`H264_PREFERENCE`]; software H.264 is `libopenh264`. Tests may pass extra encoder names for a dev libav build.
#![allow(clippy::too_many_arguments)]

mod decode;
mod encode;
pub mod openh264;
mod session;

pub use decode::{block_on, open_file, LibavHost};
pub use encode::{
    encoder_available, encoder_opens, video_encoder_names, webm_available, AudioConfig, Container,
    EncoderConfig, ExportStats, MediaEncoder, Mp4Encoder, H264_PREFERENCE, OPUS_ENCODER,
    VP9_ENCODER,
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
    fn webm_names_only_royalty_free_encoders() {
        use crate::{video_encoder_names, Container};
        assert_eq!(
            video_encoder_names(Container::WebM, false, None),
            ["libvpx-vp9"]
        );
        assert_eq!(
            video_encoder_names(Container::WebM, true, None),
            ["libvpx-vp9"]
        );
    }

    #[test]
    fn mp4_preset_is_hardware_first_and_software_only_when_asked() {
        use crate::{video_encoder_names, Container};
        let all = video_encoder_names(Container::Mp4, false, None);
        assert_eq!(all.first().map(String::as_str), Some("h264_videotoolbox"));
        assert_eq!(all.last().map(String::as_str), Some("libopenh264"));
        assert_eq!(
            video_encoder_names(Container::Mp4, true, None),
            ["libopenh264"]
        );
        let own = ["libx264".to_string()];
        assert_eq!(
            video_encoder_names(Container::Mp4, true, Some(&own)),
            ["libx264"]
        );
    }

    #[test]
    fn container_follows_the_file_name() {
        use crate::Container;
        assert_eq!(Container::of_file_name("a.mp4"), Some(Container::Mp4));
        assert_eq!(Container::of_file_name("a.b.WEBM"), Some(Container::WebM));
        assert_eq!(Container::of_file_name("a.mkv"), None);
        assert_eq!(Container::of_file_name("webm"), None);
    }

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
