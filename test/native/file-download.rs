#[path = "../../src-tauri/plugins/tauri-plugin-file-download/src/filename.rs"]
mod filename;

#[test]
fn names_are_safe_on_mac_and_windows() {
  assert_eq!(filename::safe_filename("../../report.pdf"), "report.pdf");
  assert_eq!(filename::safe_filename("C:\\tmp\\report.pdf"), "report.pdf");
  assert_eq!(filename::safe_filename("CON.txt"), "_CON.txt");
  assert_eq!(filename::safe_filename(".."), "download");
  assert_eq!(filename::safe_filename("bad:name?.txt"), "bad_name_.txt");
  let long = filename::safe_filename(&("文件".repeat(200) + ".pptx"));
  assert!(long.len() < 220);
  assert!(long.ends_with(".pptx"));
}

#[test]
fn downloads_never_overwrite_an_existing_file() {
  let root = std::env::temp_dir().join(format!("baton-download-test-{}", std::process::id()));
  std::fs::create_dir_all(&root).unwrap();
  let (first, first_file) = filename::reserve_file(&root, "report.pdf").unwrap();
  let (second, second_file) = filename::reserve_file(&root, "report.pdf").unwrap();
  assert_ne!(first, second);
  assert_eq!(second.file_name().unwrap(), "report (1).pdf");
  drop(first_file);
  drop(second_file);
  std::fs::remove_dir_all(root).unwrap();
}
