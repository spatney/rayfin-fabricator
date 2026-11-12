//! Text from a stream of bytes that may split a UTF-8 character between reads.

/// Decodes UTF-8 a chunk at a time, holding back a character split across
/// chunks until the rest of it arrives. Invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
  /// The start of a character the last chunk ended in the middle of.
  partial: Vec<u8>,
}

impl Utf8Stream {
  pub fn decode(&mut self, bytes: &[u8]) -> String {
    let mut input = std::mem::take(&mut self.partial);
    input.extend_from_slice(bytes);
    let mut text = String::with_capacity(input.len());
    let mut rest = input.as_slice();
    loop {
      match std::str::from_utf8(rest) {
        Ok(valid) => {
          text.push_str(valid);
          break;
        }
        Err(error) => {
          let (valid, after) = rest.split_at(error.valid_up_to());
          text.push_str(std::str::from_utf8(valid).unwrap_or_default());
          match error.error_len() {
            Some(invalid) => {
              text.push(char::REPLACEMENT_CHARACTER);
              rest = &after[invalid..];
            }
            None => {
              self.partial = after.to_vec();
              break;
            }
          }
        }
      }
    }
    text
  }

  /// What's left when the stream ends: an unfinished character, as U+FFFD.
  pub fn finish(&mut self) -> String {
    if std::mem::take(&mut self.partial).is_empty() {
      String::new()
    } else {
      char::REPLACEMENT_CHARACTER.to_string()
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_character_split_between_reads_arrives_whole() {
    let bytes = "ok ✓ 🐟".as_bytes();
    for split in 0..=bytes.len() {
      let mut stream = Utf8Stream::default();
      let (a, b) = bytes.split_at(split);
      let text = stream.decode(a) + &stream.decode(b) + &stream.finish();
      assert_eq!(text, "ok ✓ 🐟", "split at {split}");
    }
  }

  #[test]
  fn one_byte_at_a_time() {
    let mut stream = Utf8Stream::default();
    let text: String = "λx → 🦈\r\n".as_bytes().iter().map(|byte| stream.decode(&[*byte])).collect();
    assert_eq!(text, "λx → 🦈\r\n");
  }

  #[test]
  fn invalid_bytes_become_replacement_characters() {
    let mut stream = Utf8Stream::default();
    assert_eq!(stream.decode(b"a\xffb\xc3"), "a\u{FFFD}b");
    // The stream ends inside a character.
    assert_eq!(stream.finish(), "\u{FFFD}");
    assert_eq!(stream.finish(), "");
  }
}
