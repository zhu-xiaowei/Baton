use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

pub fn safe_filename(name: &str) -> String {
  let name = name.rsplit(['/', '\\']).next().unwrap_or("download");
  let cleaned: String = name.chars().map(|character| {
    if character.is_control() || "<>:\"|?*".contains(character) { '_' } else { character }
  }).collect();
  let cleaned = cleaned.trim_matches([' ', '.']);
  let path = Path::new(cleaned);
  let extension = path.extension().and_then(|value| value.to_str()).filter(|value| value.len() <= 20);
  let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("download");
  let mut result = String::new();
  for character in stem.chars() {
    if result.len() + character.len_utf8() > 180 { break; }
    result.push(character);
  }
  if result.is_empty() { result.push_str("download"); }
  let upper = result.to_ascii_uppercase();
  if ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
      "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&upper.as_str()) {
    result.insert(0, '_');
  }
  if let Some(extension) = extension { result.push('.'); result.push_str(extension); }
  result
}

pub fn reserve_file(directory: &Path, name: &str) -> std::io::Result<(PathBuf, File)> {
  let name = safe_filename(name);
  let original = Path::new(&name);
  for index in 0..10000 {
    let filename = if index == 0 { name.clone() } else {
      let stem = original.file_stem().unwrap().to_string_lossy();
      let suffix = original.extension().map(|value| format!(".{}", value.to_string_lossy())).unwrap_or_default();
      format!("{stem} ({index}){suffix}")
    };
    let path = directory.join(filename);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(file) => return Ok((path, file)),
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(error) => return Err(error),
    }
  }
  Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "Too many files with the same name"))
}
