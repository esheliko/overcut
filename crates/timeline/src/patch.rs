//! `EditPatch`: what an edit changed, so the UI updates its copy of the project without re-reading all of it (ADR 0020).
//!
//! The editor keeps a shadow copy of the project as the UI last saw it and, after every apply/undo/redo, diffs the project against it.
//! The diff is generic (it does not depend on which op ran): per sequence the shell (everything but the tracks) when it differs, the track
//! order when it changed, and per changed track its shell plus ONE splice of the clip list (common prefix and suffix kept). A split is one
//! track patch with `remove: 1, insert: 2`. The UI applies it immutably, sharing every unchanged track and clip with the previous project.
//! `apply_patch` is the reference application; the TypeScript `applyEditPatch` does the same and is pinned to it by
//! `packages/engine-client/schema/patch-contract.json`.

use app_model::{Clip, MediaRef, Project, Sequence, SequenceId, Track, TrackId};
use serde::{Deserialize, Serialize};

/// Replace `remove` clips at `start` with `insert`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Splice {
    pub start: usize,
    pub remove: usize,
    pub insert: Vec<Clip>,
}

/// One changed (or new) track. `shell` is the track without clips, present when any other field differs or the track is new.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackPatch {
    pub id: TrackId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<Track>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub splice: Option<Splice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SequencePatch {
    pub id: SequenceId,
    /// The sequence without its tracks, when anything but the tracks changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<Sequence>,
    /// Every track id, bottom to top, when a track was added, removed or moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<TrackId>>,
    pub tracks: Vec<TrackPatch>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EditPatch {
    /// The whole media list, when it changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<Vec<MediaRef>>,
    /// Only the sequences that changed.
    pub sequences: Vec<SequencePatch>,
}

// The shells are built field by field (exhaustive destructuring, no `..`) so the clips are never cloned just to be thrown away,
// and a field added to `Track` or `Sequence` stops compiling here until it is handled.
fn track_shell(t: &Track) -> Track {
    let Track {
        id,
        kind,
        name,
        muted,
        locked,
        hidden,
        solo,
        height,
        colour,
        clips: _,
    } = t;
    Track {
        id: *id,
        kind: *kind,
        name: name.clone(),
        muted: *muted,
        locked: *locked,
        hidden: *hidden,
        solo: *solo,
        height: *height,
        colour: colour.clone(),
        clips: Vec::new(),
    }
}

fn seq_shell(s: &Sequence) -> Sequence {
    let Sequence {
        id,
        name,
        frame_rate,
        resolution,
        size_fixed,
        rate_fixed,
        sample_rate,
        tracks: _,
        markers,
        range,
        loop_range,
    } = s;
    Sequence {
        id: *id,
        name: name.clone(),
        frame_rate: *frame_rate,
        resolution: *resolution,
        size_fixed: *size_fixed,
        rate_fixed: *rate_fixed,
        sample_rate: *sample_rate,
        tracks: Vec::new(),
        markers: markers.clone(),
        range: *range,
        loop_range: *loop_range,
    }
}

fn splice_of(a: &[Clip], b: &[Clip]) -> Option<Splice> {
    let max = a.len().min(b.len());
    let mut p = 0;
    while p < max && a[p] == b[p] {
        p += 1;
    }
    if p == a.len() && p == b.len() {
        return None;
    }
    let mut s = 0;
    while s < max - p && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
        s += 1;
    }
    Some(Splice {
        start: p,
        remove: a.len() - p - s,
        insert: b[p..b.len() - s].to_vec(),
    })
}

fn diff_track(before: Option<&Track>, after: &Track) -> Option<TrackPatch> {
    match before {
        None => Some(TrackPatch {
            id: after.id,
            shell: Some(track_shell(after)),
            splice: (!after.clips.is_empty()).then(|| Splice {
                start: 0,
                remove: 0,
                insert: after.clips.clone(),
            }),
        }),
        Some(b) => {
            let shell = (track_shell(b) != track_shell(after)).then(|| track_shell(after));
            let splice = splice_of(&b.clips, &after.clips);
            (shell.is_some() || splice.is_some()).then_some(TrackPatch {
                id: after.id,
                shell,
                splice,
            })
        }
    }
}

/// What changed from `before` to `after`. `None` when the change is not expressible as a patch (the project's own id, name or schema
/// version, or its list of sequences changed): the caller re-reads the whole project.
pub fn diff(before: &Project, after: &Project) -> Option<EditPatch> {
    if before.schema_version != after.schema_version
        || before.id != after.id
        || before.name != after.name
        || before.sequences.len() != after.sequences.len()
        || before
            .sequences
            .iter()
            .zip(&after.sequences)
            .any(|(a, b)| a.id != b.id)
    {
        return None;
    }
    let mut out = EditPatch {
        media: (before.media != after.media).then(|| after.media.clone()),
        sequences: Vec::new(),
    };
    for (bs, s) in before.sequences.iter().zip(&after.sequences) {
        let shell = (seq_shell(bs) != seq_shell(s)).then(|| seq_shell(s));
        let same_order = bs.tracks.len() == s.tracks.len()
            && bs.tracks.iter().zip(&s.tracks).all(|(a, b)| a.id == b.id);
        let order = (!same_order).then(|| s.tracks.iter().map(|t| t.id).collect());
        let tracks = s
            .tracks
            .iter()
            .filter_map(|t| diff_track(bs.tracks.iter().find(|b| b.id == t.id), t))
            .collect();
        let tracks: Vec<TrackPatch> = tracks;
        if shell.is_none() && order.is_none() && tracks.is_empty() {
            continue;
        }
        out.sequences.push(SequencePatch {
            id: s.id,
            shell,
            order,
            tracks,
        });
    }
    Some(out)
}

/// Applies a patch made by [`diff`] to the project it was made from. Reference for the UI's `applyEditPatch`.
pub fn apply_patch(p: &mut Project, patch: &EditPatch) -> Result<(), String> {
    if let Some(m) = &patch.media {
        p.media = m.clone();
    }
    for sp in &patch.sequences {
        let seq = p
            .sequences
            .iter_mut()
            .find(|s| s.id == sp.id)
            .ok_or("patch names an unknown sequence")?;
        if let Some(shell) = &sp.shell {
            let tracks = std::mem::take(&mut seq.tracks);
            *seq = Sequence {
                tracks,
                ..shell.clone()
            };
        }
        for tp in &sp.tracks {
            if seq.tracks.iter().all(|t| t.id != tp.id) {
                let shell = tp
                    .shell
                    .clone()
                    .ok_or("patch adds a track without its shell")?;
                seq.tracks.push(shell);
            }
            let t = seq
                .tracks
                .iter_mut()
                .find(|t| t.id == tp.id)
                .expect("just ensured");
            if let Some(shell) = &tp.shell {
                let clips = std::mem::take(&mut t.clips);
                *t = Track {
                    clips,
                    ..shell.clone()
                };
            }
            if let Some(sl) = &tp.splice {
                if sl.start + sl.remove > t.clips.len() {
                    return Err("patch splice is out of range".into());
                }
                t.clips
                    .splice(sl.start..sl.start + sl.remove, sl.insert.iter().cloned());
            }
        }
        if let Some(order) = &sp.order {
            let mut old = std::mem::take(&mut seq.tracks);
            let mut next = Vec::with_capacity(order.len());
            for id in order {
                let i = old
                    .iter()
                    .position(|t| t.id == *id)
                    .ok_or("patch order names an unknown track")?;
                next.push(old.swap_remove(i));
            }
            seq.tracks = next;
        }
    }
    Ok(())
}
