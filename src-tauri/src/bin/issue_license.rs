fn main() {
    let mut machine = None;
    let mut days = 30u16;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--machine" => machine = args.next(),
            "--days" => {
                days = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(30);
            }
            "--help" | "-h" => {
                eprintln!("issue-license [--machine XXXX-XXXX-XXXX-XXXX] [--days 30]");
                return;
            }
            other => {
                eprintln!("未知参数：{other}");
                std::process::exit(2);
            }
        }
    }
    println!(
        "{}",
        infinite_canvas_lib::issue_paid_license(machine.as_deref(), days)
    );
}
