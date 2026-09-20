#[derive(Debug)]
struct IssueLicenseArgs {
    machine: Option<String>,
    days: u16,
}

fn parse_issue_license_args(
    args: impl IntoIterator<Item = String>,
) -> Result<Option<IssueLicenseArgs>, String> {
    let mut machine = None;
    let mut days = 30u16;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--machine" => match args.next() {
                Some(value) if !value.trim().is_empty() => machine = Some(value),
                _ => return Err("--machine 需要机器码参数".into()),
            },
            "--days" => match args.next().and_then(|value| value.parse::<u16>().ok()) {
                Some(value) if value > 0 => days = value,
                _ => return Err("--days 需要正整数天数".into()),
            },
            "--help" | "-h" => return Ok(None),
            other => return Err(format!("未知参数：{other}")),
        }
    }
    Ok(Some(IssueLicenseArgs { machine, days }))
}

fn main() {
    match parse_issue_license_args(std::env::args().skip(1)) {
        Ok(None) => {
            eprintln!("issue-license [--machine XXXX-XXXX-XXXX-XXXX] [--days 30]");
        }
        Ok(Some(args)) => {
            println!(
                "{}",
                infinite_canvas_lib::issue_paid_license(args.machine.as_deref(), args.days)
            );
        }
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{IssueLicenseArgs, parse_issue_license_args};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn parse(values: &[&str]) -> Result<Option<IssueLicenseArgs>, String> {
        parse_issue_license_args(args(values))
    }

    #[test]
    fn omitted_flags_issue_unbound_30_day_code() {
        let parsed = parse(&[]).unwrap().unwrap();
        assert_eq!(parsed.machine, None);
        assert_eq!(parsed.days, 30);
    }

    #[test]
    fn machine_and_days_are_kept() {
        let parsed = parse(&["--machine", "ABCD-EFGH-IJKL-MNOP", "--days", "7"])
            .unwrap()
            .unwrap();
        assert_eq!(parsed.machine.as_deref(), Some("ABCD-EFGH-IJKL-MNOP"));
        assert_eq!(parsed.days, 7);
    }

    #[test]
    fn missing_or_blank_machine_value_errors() {
        assert_eq!(
            parse(&["--machine"]).unwrap_err(),
            "--machine 需要机器码参数"
        );
        assert_eq!(
            parse(&["--machine", "  "]).unwrap_err(),
            "--machine 需要机器码参数"
        );
    }

    #[test]
    fn missing_or_invalid_days_value_errors() {
        assert_eq!(parse(&["--days"]).unwrap_err(), "--days 需要正整数天数");
        assert_eq!(
            parse(&["--days", "abc"]).unwrap_err(),
            "--days 需要正整数天数"
        );
        assert_eq!(
            parse(&["--days", "0"]).unwrap_err(),
            "--days 需要正整数天数"
        );
    }

    #[test]
    fn help_does_not_issue_a_code() {
        assert!(parse(&["--help"]).unwrap().is_none());
        assert!(parse(&["-h"]).unwrap().is_none());
    }
}
