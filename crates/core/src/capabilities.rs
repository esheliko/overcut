//! What this device and host can do (M1-006).
//!
//! The host (browser or Tauri webview) probes its own APIs (WebCodecs, WebGPU, WebGL2, storage, ...) and hands the
//! raw answer to the engine as JSON. The engine normalises it here: unknown or missing fields become "unknown",
//! never an error, so a half-failed probe still yields a usable report. The native shell adds the facts only it
//! knows (OS, architecture, core count) through [`NativeInfo`].

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How well a codec direction works on this device.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    /// Works and a hardware path was confirmed.
    Hardware,
    /// Works (hardware not confirmed: software, or the browser does not say).
    Supported,
    /// The device or browser says no.
    No,
    /// Not probed, or the probe itself failed.
    #[default]
    Unknown,
}

impl Support {
    pub fn works(self) -> bool {
        matches!(self, Support::Hardware | Support::Supported)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CodecSupport {
    /// Short name: `h264`, `hevc`, `vp9`, `av1`.
    pub codec: String,
    /// The exact WebCodecs codec string that was tested.
    pub tested: String,
    pub decode: Support,
    pub encode: Support,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GpuAdapter {
    pub vendor: String,
    pub architecture: String,
    pub device: String,
    pub description: String,
    /// True when the browser fell back to a software renderer (slow).
    pub fallback: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WebGpuInfo {
    pub available: bool,
    pub adapter: Option<GpuAdapter>,
    /// Selected `GPUSupportedLimits` (texture size, buffer sizes, workgroup limits).
    pub limits: BTreeMap<String, f64>,
    pub features: Vec<String>,
    /// Why it is unavailable, when the probe knows.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WebGl2Info {
    pub available: bool,
    pub renderer: Option<String>,
    pub max_texture_size: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PlatformInfo {
    pub user_agent: String,
    pub platform: String,
    /// Native shell only: `windows`, `macos`, `linux`, `ios`, `android`.
    pub os: Option<String>,
    pub arch: Option<String>,
    pub hardware_concurrency: Option<u32>,
    /// `navigator.deviceMemory`: coarse, capped at 8 GB, absent on Safari and Firefox.
    pub device_memory_gb: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Capabilities {
    /// `web` (browser, PWA) or `tauri` (native shell).
    pub host: String,
    pub platform: PlatformInfo,
    pub codecs: Vec<CodecSupport>,
    pub webgpu: WebGpuInfo,
    pub webgl2: WebGl2Info,
    pub shared_array_buffer: bool,
    pub cross_origin_isolated: bool,
    pub opfs: bool,
    pub web_workers: bool,
    pub offscreen_canvas: bool,
    /// Plain-language gaps (filled by the engine from the rest of this struct).
    pub issues: Vec<String>,
}

/// Facts only the native shell has; they override whatever the webview guessed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeInfo {
    pub os: String,
    pub arch: String,
    pub cores: Option<u32>,
}

impl Capabilities {
    /// Plain-language gaps that will limit the editor on this device. Empty means nothing notable is missing.
    pub fn find_issues(&self) -> Vec<String> {
        let mut out = Vec::new();
        let h264 = self.codecs.iter().find(|c| c.codec == "h264");
        if h264.is_some_and(|c| !c.decode.works()) {
            out.push(
                "This device cannot decode H.264 video: imports will be slow or fail.".to_string(),
            );
        }
        if h264.is_some_and(|c| c.encode == Support::No) {
            out.push(
                "This device cannot encode H.264 video: export needs another route.".to_string(),
            );
        }
        if !self.webgpu.available && !self.webgl2.available {
            out.push("No GPU graphics API is available: previews will not render.".to_string());
        } else if !self.webgpu.available {
            out.push(
                "WebGPU is not available: the editor falls back to WebGL2 (fewer effects, slower)."
                    .to_string(),
            );
        }
        if self.webgpu.adapter.as_ref().is_some_and(|a| a.fallback) {
            out.push("The GPU is a software renderer (very slow).".to_string());
        }
        if self.host == "web" && !self.cross_origin_isolated {
            out.push(
                "The page is not cross-origin isolated: multi-threaded features are off."
                    .to_string(),
            );
        }
        if !self.opfs {
            out.push(
                "No private file storage (OPFS): large projects cannot be cached on this device."
                    .to_string(),
            );
        }
        out
    }
}

/// Parses the host's raw probe JSON. Anything missing or mistyped inside a section falls back to that section's
/// default; only a payload that is not a JSON object at all is an error.
pub fn capabilities_from_probe(probe_json: &str) -> Result<Capabilities, String> {
    let v: serde_json::Value =
        serde_json::from_str(probe_json).map_err(|e| format!("probe is not JSON: {e}"))?;
    let obj = v.as_object().ok_or("probe is not a JSON object")?;
    fn section<T: serde::de::DeserializeOwned + Default>(
        o: &serde_json::Map<String, serde_json::Value>,
        k: &str,
    ) -> T {
        o.get(k)
            .and_then(|x| serde_json::from_value(x.clone()).ok())
            .unwrap_or_default()
    }
    let flag = |k: &str| obj.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
    let codecs = obj
        .get("codecs")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| serde_json::from_value::<CodecSupport>(c.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    Ok(Capabilities {
        host: String::new(),
        platform: section(obj, "platform"),
        codecs,
        webgpu: section(obj, "webgpu"),
        webgl2: section(obj, "webgl2"),
        shared_array_buffer: flag("shared_array_buffer"),
        cross_origin_isolated: flag("cross_origin_isolated"),
        opfs: flag("opfs"),
        web_workers: flag("web_workers"),
        offscreen_canvas: flag("offscreen_canvas"),
        issues: Vec::new(),
    })
}

/// The JSON the shells hand to the UI: the probe, normalised, stamped with the host kind and the native facts.
pub fn capabilities_json(
    probe_json: &str,
    host: &str,
    native: Option<&NativeInfo>,
) -> Result<String, String> {
    let mut caps = capabilities_from_probe(probe_json)?;
    caps.host = host.to_string();
    if let Some(n) = native {
        caps.platform.os = Some(n.os.clone());
        caps.platform.arch = Some(n.arch.clone());
        if n.cores.is_some() {
            caps.platform.hardware_concurrency = n.cores;
        }
    }
    caps.issues = caps.find_issues();
    serde_json::to_string(&caps).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"{
      "platform": {"user_agent": "UA", "platform": "MacIntel", "hardware_concurrency": 8, "device_memory_gb": 8},
      "codecs": [{"codec": "h264", "tested": "avc1.640028", "decode": "hardware", "encode": "supported"},
                 {"codec": "av1", "tested": "av01.0.08M.08", "decode": "no", "encode": "no"}],
      "webgpu": {"available": true, "adapter": {"vendor": "apple", "architecture": "metal-3", "fallback": false},
                 "limits": {"maxTextureDimension2D": 16384}, "features": ["timestamp-query"]},
      "webgl2": {"available": true, "renderer": "Apple GPU", "max_texture_size": 16384},
      "shared_array_buffer": true, "cross_origin_isolated": true, "opfs": true, "web_workers": true, "offscreen_canvas": true
    }"#;

    #[test]
    fn full_probe_round_trips() {
        let json = capabilities_json(FULL, "web", None).unwrap();
        let caps: Capabilities = serde_json::from_str(&json).unwrap();
        assert_eq!(caps.host, "web");
        assert_eq!(caps.codecs.len(), 2);
        assert_eq!(caps.codecs[0].decode, Support::Hardware);
        assert_eq!(caps.webgpu.limits["maxTextureDimension2D"], 16384.0);
        assert_eq!(caps.platform.device_memory_gb, Some(8.0));
        assert!(caps.issues.is_empty(), "{:?}", caps.issues);
    }

    #[test]
    fn empty_and_partial_probes_degrade_to_unknown_not_errors() {
        let caps = capabilities_from_probe("{}").unwrap();
        assert!(!caps.webgpu.available && caps.codecs.is_empty());
        let caps = capabilities_from_probe(r#"{"webgpu": "garbage", "codecs": [{"codec":"h264","decode":"wat"}, {"codec":"vp9","decode":"no"}]}"#).unwrap();
        assert_eq!(caps.webgpu, WebGpuInfo::default());
        assert_eq!(
            caps.codecs.len(),
            1,
            "an entry with an unknown value is dropped, the rest survive"
        );
        assert_eq!(caps.codecs[0].codec, "vp9");
    }

    #[test]
    fn non_objects_are_rejected() {
        assert!(capabilities_from_probe("[]").is_err());
        assert!(capabilities_from_probe("nope").is_err());
    }

    #[test]
    fn native_facts_override_the_webview() {
        let native = NativeInfo {
            os: "windows".into(),
            arch: "x86_64".into(),
            cores: Some(16),
        };
        let caps: Capabilities =
            serde_json::from_str(&capabilities_json(FULL, "tauri", Some(&native)).unwrap())
                .unwrap();
        assert_eq!(caps.host, "tauri");
        assert_eq!(caps.platform.os.as_deref(), Some("windows"));
        assert_eq!(caps.platform.hardware_concurrency, Some(16));
    }

    #[test]
    fn issues_name_the_gaps_in_plain_words() {
        let caps =
            capabilities_from_probe(r#"{"codecs":[{"codec":"h264","decode":"no","encode":"no"}]}"#)
                .unwrap();
        let mut caps = caps;
        caps.host = "web".into();
        let text = caps.find_issues().join(" | ");
        assert!(
            text.contains("decode H.264")
                && text.contains("No GPU")
                && text.contains("isolated")
                && text.contains("OPFS"),
            "{text}"
        );
    }
}
