//! Stable ids. 128 bits, serialized as 32 lowercase hex characters (a string, so JavaScript never loses precision).
//! The model never generates randomness itself (no I/O): the host supplies an [`IdSource`].

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Cow;
use std::fmt;

/// An untyped 128-bit id. Use the typed wrappers ([`ClipId`] ...) in the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Id(u128);

impl Id {
    pub const fn from_u128(v: u128) -> Id {
        Id(v)
    }

    pub const fn as_u128(self) -> u128 {
        self.0
    }

    /// Parses exactly 32 lowercase hex characters.
    pub fn parse(s: &str) -> Option<Id> {
        let ok = s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if !ok {
            return None;
        }
        u128::from_str_radix(s, 16).ok().map(Id)
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:032x}", self.0)
    }
}

/// Where fresh ids come from. The host provides random ones; tests use [`SeqIds`].
pub trait IdSource {
    fn next_id(&mut self) -> Id;
}

/// Deterministic counter ids (1, 2, 3 ...) for tests and replay.
#[derive(Default, Debug)]
pub struct SeqIds(u128);

impl IdSource for SeqIds {
    fn next_id(&mut self) -> Id {
        self.0 += 1;
        Id(self.0)
    }
}

macro_rules! typed_id {
    ($(#[$m:meta])* $name:ident) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub Id);

        impl $name {
            pub fn new(src: &mut impl IdSource) -> Self {
                $name(src.next_id())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Id::parse(&s).map($name).ok_or_else(|| {
                    serde::de::Error::custom(concat!(
                        stringify!($name),
                        " must be 32 lowercase hex characters"
                    ))
                })
            }
        }

        impl JsonSchema for $name {
            fn schema_name() -> Cow<'static, str> {
                Cow::Borrowed(stringify!($name))
            }
            fn json_schema(_: &mut SchemaGenerator) -> Schema {
                json_schema!({ "type": "string", "pattern": "^[0-9a-f]{32}$" })
            }
        }
    };
}

typed_id!(
    /// Id of a [`crate::Project`].
    ProjectId
);
typed_id!(
    /// Id of a [`crate::Sequence`].
    SequenceId
);
typed_id!(
    /// Id of a [`crate::Track`].
    TrackId
);
typed_id!(
    /// Id of a [`crate::Clip`].
    ClipId
);
typed_id!(
    /// Id of a [`crate::MediaRef`].
    MediaId
);
typed_id!(
    /// Id shared by the clips that move and trim together (a video clip and the sound of the same import): `Clip::link`.
    LinkId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_as_32_hex_chars() {
        let id = ClipId(Id::from_u128(0xabc));
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"00000000000000000000000000000abc\"");
        assert_eq!(serde_json::from_str::<ClipId>(&json).unwrap(), id);
    }

    #[test]
    fn rejects_malformed_ids() {
        for bad in [
            "\"abc\"",
            "\"0000000000000000000000000000ABCD\"",
            "\"zz000000000000000000000000000000\"",
            "7",
        ] {
            assert!(serde_json::from_str::<ClipId>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn seq_ids_are_distinct_and_deterministic() {
        let mut a = SeqIds::default();
        let (x, y) = (ClipId::new(&mut a), ClipId::new(&mut a));
        assert_ne!(x, y);
        assert_eq!(x, ClipId(Id::from_u128(1)));
    }
}
