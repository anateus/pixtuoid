// The pilot's Rust-std half: what the tier's own Rust would see on Windows.
use std::io::Write;
use std::process::Command;

fn main() {
    let tmp = std::env::temp_dir();
    println!("temp_dir: {tmp:?}");
    println!("canonicalize(temp_dir): {:?}", std::fs::canonicalize(&tmp));
    match std::fs::read_dir(r"\\.\pipe\") {
        Ok(it) => println!("read_dir(\\\\.\\pipe\\): ok, {} entries", it.count()),
        Err(e) => println!("read_dir(\\\\.\\pipe\\): {e}"),
    }
    for program in ["npm", "npm.cmd", "git"] {
        let r = Command::new(program).arg("--version").output();
        println!(
            "Command::new({program:?}): {:?}",
            r.map(|o| (o.status, String::from_utf8_lossy(&o.stdout).trim().to_string()))
        );
    }
    println!("USER: {:?}, USERNAME: {:?}", std::env::var_os("USER"), std::env::var_os("USERNAME"));
    println!("home_dir: {:?}", std::env::home_dir());
    let _ = std::io::stdout().flush();
}
