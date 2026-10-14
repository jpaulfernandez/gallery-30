//! Plan 46: a haptic tick on the Force Touch trackpad (ODDHALLS_UI_PLAN 4.3).
//!
//! `haptic(kind)` asks `NSHapticFeedbackManager`'s default performer for one of its three patterns. macOS does
//! nothing on a trackpad without Force Touch (or with no trackpad at all), and every other platform has no
//! performer, so the command always returns `Ok`. The rate limit, the Settings switch and reduced motion are the
//! webview's (`src/lib/haptic.ts`); this side only plays the pattern.

use serde::Deserialize;

use crate::error::Result;

/// The three `NSHapticFeedbackPattern`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HapticKind {
    /// A snap: the slider detent, a frame landing on a guide, the straighten angle at 0°.
    Alignment,
    /// A step between discrete levels: the zoom at Fit or 100 %.
    LevelChange,
    Generic,
}

/// Plays `kind` once. A sync command, so Tauri runs it on the main thread, where AppKit expects it.
#[tauri::command]
pub fn haptic(kind: HapticKind) -> Result<()> {
    perform(kind);
    Ok(())
}

#[cfg(target_os = "macos")]
fn perform(kind: HapticKind) {
    use objc2_app_kit::{
        NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime, NSHapticFeedbackPerformer,
    };
    let pattern = match kind {
        HapticKind::Alignment => NSHapticFeedbackPattern::Alignment,
        HapticKind::LevelChange => NSHapticFeedbackPattern::LevelChange,
        HapticKind::Generic => NSHapticFeedbackPattern::Generic,
    };
    NSHapticFeedbackManager::defaultPerformer()
        .performFeedbackPattern_performanceTime(pattern, NSHapticFeedbackPerformanceTime::Now);
}

#[cfg(not(target_os = "macos"))]
fn perform(_kind: HapticKind) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_parse_from_the_webview_names() {
        let parse = |s: &str| serde_json::from_str::<HapticKind>(&format!("\"{s}\"")).unwrap();
        assert_eq!(parse("alignment"), HapticKind::Alignment);
        assert_eq!(parse("levelChange"), HapticKind::LevelChange);
        assert_eq!(parse("generic"), HapticKind::Generic);
        assert!(serde_json::from_str::<HapticKind>("\"buzz\"").is_err());
    }

    #[test]
    fn every_kind_returns_ok() {
        // On a Mac without Force Touch (CI, a desktop) the performer is silent; elsewhere there is none.
        for kind in [HapticKind::Alignment, HapticKind::LevelChange, HapticKind::Generic] {
            assert!(haptic(kind).is_ok());
        }
    }
}
