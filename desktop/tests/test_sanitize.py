import numpy as np

from captions_desktop.sanitize import (
    collapse_repeats,
    is_degenerate,
    is_likely_speech,
    peak_rms,
)


def test_speech_gate_rejects_silence_and_too_short():
    sr = 16000
    assert not is_likely_speech(np.zeros(sr, dtype=np.float32), sr)  # 1s of silence
    loud_but_brief = np.full(int(sr * 0.1), 0.2, dtype=np.float32)  # 100ms < 250ms
    assert not is_likely_speech(loud_but_brief, sr)


def test_speech_gate_passes_loud_enough_clip():
    sr = 16000
    clip = np.full(sr, 0.05, dtype=np.float32)  # 1s, peak 0.05 > MIN_PEAK_RMS
    assert is_likely_speech(clip, sr)
    assert peak_rms(np.zeros(sr, dtype=np.float32), sr) == 0.0


def test_is_degenerate_flags_junk():
    assert is_degenerate("")
    assert is_degenerate("   ")
    assert is_degenerate(">>>>")
    assert is_degenerate("[[[[")
    assert is_degenerate("....")


def test_is_degenerate_keeps_real_text():
    assert not is_degenerate("Hello world.")
    assert not is_degenerate("OK.")  # short but real


def test_collapse_repeats_single_word():
    assert collapse_repeats("warning warning warning warning") == "warning"
    assert collapse_repeats("hi stop stop stop bye") == "hi stop bye"


def test_collapse_repeats_spares_a_double():
    assert collapse_repeats("very very good") == "very very good"


def test_collapse_repeats_phrase():
    assert (
        collapse_repeats("I'm sorry. I'm sorry. I'm sorry. I'm sorry.") == "I'm sorry."
    )
    assert (
        collapse_repeats("ok thank you thank you thank you thank you bye")
        == "ok thank you bye"
    )


def test_collapse_repeats_ignores_case_and_punct():
    assert collapse_repeats("No, no no no thanks") == "No, thanks"


def test_collapse_repeats_smallest_period():
    # single word repeated, not a 2-word phrase
    assert collapse_repeats("na na na na na batman") == "na batman"
