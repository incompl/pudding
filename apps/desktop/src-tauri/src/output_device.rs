//! CPAL's macOS output stream format is independent of the hardware rate.
//! Keep a stable hardware device ID alongside CPAL's handle so source matching
//! and restoration change the same device, even if the system default changes.

#[cfg(not(target_os = "macos"))]
use cpal::traits::DeviceTrait;
use cpal::traits::HostTrait;

#[derive(Clone)]
pub(crate) struct OutputDevice {
    pub device: cpal::Device,
    #[cfg(target_os = "macos")]
    id: u32,
}

impl OutputDevice {
    pub fn default() -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            let (device, id) = stable_default_device(macos::default_output_id, || {
                cpal::default_host()
                    .default_output_device()
                    .ok_or_else(|| "no default output device".to_string())
            })?;
            Ok(Self { device, id })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let device = cpal::default_host()
                .default_output_device()
                .ok_or_else(|| "no default output device".to_string())?;
            Ok(Self { device })
        }
    }

    pub fn current_rate(&self) -> Result<u32, String> {
        #[cfg(target_os = "macos")]
        return macos::rate(self.id);
        #[cfg(not(target_os = "macos"))]
        self.device
            .default_output_config()
            .map(|cfg| cfg.sample_rate().0)
            .map_err(|e| format!("could not read current output rate: {e}"))
    }

    // Call only after dropping the old stream. Other CPAL backends configure
    // their device when the replacement stream is built.
    pub fn set_rate(&self, rate: u32) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        return macos::set_rate(self.id, rate);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = rate;
            Ok(())
        }
    }

    pub fn verify_rate(&self, expected: u32) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let actual = self.current_rate()?;
            if actual != expected {
                return Err(format!(
                    "output device is at {actual} Hz after requesting {expected} Hz"
                ));
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = expected;
        Ok(())
    }
}

// CPAL 0.15 does not expose its device ID. Bracket its lookup with native
// reads, retrying the entire selection if the default changes during startup.
// Accepting just the second ID could pair one device's handle with another's ID.
#[cfg(any(target_os = "macos", test))]
fn stable_default_device<T>(
    mut read_id: impl FnMut() -> Result<u32, String>,
    mut select_device: impl FnMut() -> Result<T, String>,
) -> Result<(T, u32), String> {
    for _ in 0..5 {
        let id = read_id()?;
        let device = select_device()?;
        if read_id()? == id {
            return Ok((device, id));
        }
    }
    Err("default output device did not stabilize during audio setup".into())
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    #[test]
    fn retries_the_handle_and_id_together_when_the_default_changes() {
        let mut ids = [1, 2, 2, 3, 3, 3].into_iter();
        let mut handles = ["first device", "second device", "third device"].into_iter();
        let selected =
            stable_default_device(|| Ok(ids.next().unwrap()), || Ok(handles.next().unwrap()))
                .unwrap();
        assert_eq!(selected, ("third device", 3));
    }

    #[test]
    fn stable_selection_needs_only_one_handle_lookup() {
        let mut lookups = 0;
        let selected = stable_default_device(
            || Ok(7),
            || {
                lookups += 1;
                Ok("device")
            },
        )
        .unwrap();
        assert_eq!(selected, ("device", 7));
        assert_eq!(lookups, 1);
    }

    #[test]
    fn persistent_device_churn_is_bounded() {
        let mut id = 0;
        let result = stable_default_device(
            || {
                id += 1;
                Ok(id)
            },
            || Ok("device"),
        );
        assert!(result.unwrap_err().contains("did not stabilize"));
        assert_eq!(id, 10);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use coreaudio_sys::{
        kAudioDevicePropertyNominalSampleRate, kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal,
        kAudioObjectSystemObject, AudioObjectGetPropertyData, AudioObjectPropertyAddress,
        AudioObjectSetPropertyData,
    };
    use std::mem::size_of;
    use std::ptr::null;
    use std::time::{Duration, Instant};

    fn address(selector: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        }
    }

    // The caller must choose the CoreAudio property type corresponding to T.
    unsafe fn read_property<T: Default>(id: u32, selector: u32) -> Result<T, String> {
        let mut value = T::default();
        let mut size = size_of::<T>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                id,
                &address(selector),
                0,
                null(),
                &mut size,
                (&mut value as *mut T).cast(),
            )
        };
        if status != 0 || size != size_of::<T>() as u32 {
            return Err(format!("CoreAudio read property {selector:#x} on device {id}: status={status}, size={size}"));
        }
        Ok(value)
    }

    pub(super) fn default_output_id() -> Result<u32, String> {
        // Safety: DefaultOutputDevice contains an AudioDeviceID (UInt32).
        let id = unsafe {
            read_property::<u32>(
                kAudioObjectSystemObject,
                kAudioHardwarePropertyDefaultOutputDevice,
            )?
        };
        if id == 0 {
            return Err("no default CoreAudio output device".into());
        }
        Ok(id)
    }

    pub(super) fn rate(id: u32) -> Result<u32, String> {
        // Safety: NominalSampleRate contains a Float64.
        let rate = unsafe { read_property::<f64>(id, kAudioDevicePropertyNominalSampleRate)? };
        if !rate.is_finite() || rate < 1.0 || rate > u32::MAX as f64 {
            return Err(format!("invalid nominal sample rate {rate} on device {id}"));
        }
        Ok(rate.round() as u32)
    }

    pub(super) fn set_rate(id: u32, target: u32) -> Result<(), String> {
        set_and_wait(
            target,
            || rate(id),
            |target| {
                let value = target as f64;
                // Safety: the property takes a Float64; value remains valid for
                // the synchronous call and the address targets this device only.
                let status = unsafe {
                    AudioObjectSetPropertyData(
                        id,
                        &address(kAudioDevicePropertyNominalSampleRate),
                        0,
                        null(),
                        size_of::<f64>() as u32,
                        (&value as *const f64).cast(),
                    )
                };
                if status != 0 {
                    return Err(format!(
                        "CoreAudio set device {id} to {target} Hz: status={status}"
                    ));
                }
                Ok(())
            },
            Duration::from_secs(1),
        )
    }

    fn set_and_wait(
        target: u32,
        mut read: impl FnMut() -> Result<u32, String>,
        mut write: impl FnMut(u32) -> Result<(), String>,
        timeout: Duration,
    ) -> Result<(), String> {
        if read()? == target {
            return Ok(());
        }
        write(target)?;
        let deadline = Instant::now() + timeout;
        loop {
            let actual = read()?;
            if actual == target {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("timed out changing nominal sample rate to {target} Hz; device is still at {actual} Hz"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::Cell;

        #[test]
        fn a_successful_set_must_change_the_reported_hardware_rate() {
            let error =
                set_and_wait(96_000, || Ok(48_000), |_| Ok(()), Duration::ZERO).unwrap_err();
            assert!(error.contains("still at 48000 Hz"));
        }

        #[test]
        fn waits_for_the_hardware_to_acknowledge_the_requested_rate() {
            let selected = Cell::new(48_000);
            let reads = Cell::new(0);
            set_and_wait(
                96_000,
                || {
                    reads.set(reads.get() + 1);
                    Ok(if reads.get() < 3 {
                        48_000
                    } else {
                        selected.get()
                    })
                },
                |rate| {
                    selected.set(rate);
                    Ok(())
                },
                Duration::from_secs(1),
            )
            .unwrap();
            assert_eq!(selected.get(), 96_000);
            assert!(reads.get() >= 3);
        }

        #[test]
        fn unchanged_rate_does_not_write_and_driver_errors_are_returned() {
            set_and_wait(
                48_000,
                || Ok(48_000),
                |_| panic!("unnecessary write"),
                Duration::ZERO,
            )
            .unwrap();
            assert_eq!(
                set_and_wait(
                    96_000,
                    || Ok(48_000),
                    |_| Err("driver rejected rate".into()),
                    Duration::ZERO
                ),
                Err("driver rejected rate".into())
            );
        }
    }
}
