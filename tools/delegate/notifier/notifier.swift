// Posts one macOS notification from the app bundle it runs in, because macOS
// takes a notification's icon from the bundle that sent it.
//
//   notifier TITLE SUBTITLE MESSAGE LANES ROOT NAME TARGET RUN_ID   post without asking for permission
//   notifier --request                              ask for permission
//   notifier                                        receive a notification click
//
// Exit codes: 0 ok, 2 bad usage, 3 not allowed, 4 timed out, 5 post failed.
import AppKit
import UserNotifications

let args = CommandLine.arguments
let center = UNUserNotificationCenter.current()

func exitAfter(seconds: Double) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(4) }
}

// MARK: - Click

final class ClickHandler: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completion: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
            let root = info["root"] as? String, let lane = info["lane"] as? String {
            let rootURL = URL(fileURLWithPath: root)
            if let binary = info["binary"] as? String,
                let runID = info["runID"] as? String, UUID(uuidString: runID) != nil {
                let launch = Process()
                launch.executableURL = URL(fileURLWithPath: binary)
                launch.arguments = ["open", lane, "--root", root, "--run-id", runID]
                switch info["target"] as? String {
                case "terminal": launch.arguments?.append("--terminal")
                case "report": launch.arguments?.append("--report")
                default: break
                }
                do {
                    try launch.run()
                } catch {
                    NSWorkspace.shared.activateFileViewerSelecting([rootURL.appendingPathComponent(lane)])
                }
            } else {
                NSWorkspace.shared.open(rootURL)
            }
        }
        completion()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

if args.count == 1 {
    let handler = ClickHandler()
    center.delegate = handler
    exitAfter(seconds: 8)
    withExtendedLifetime(handler) { NSApplication.shared.run() }
    exit(0)
}

// MARK: - Permission

// Only setup asks. The prompt belongs to this process: if it exits first, macOS
// withdraws the prompt and records a denial.
if args == [args[0], "--request"] {
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in exit(granted ? 0 : 3) }
    exitAfter(seconds: 600)
    dispatchMain()
}

// MARK: - Post

let runID: String?
switch args.count {
case 7:
    runID = nil
case 8 where args[7] == "terminal":
    runID = nil
case 9 where ["terminal", "report"].contains(args[7]) && UUID(uuidString: args[8]) != nil:
    runID = args[8]
default:
    exit(2)
}

let content = UNMutableNotificationContent()
content.title = args[1]
content.subtitle = args[2]
content.body = args[3]
let lane = URL(fileURLWithPath: args[5]).appendingPathComponent(args[6]).path
content.threadIdentifier = lane
content.userInfo = ["binary": args[4], "root": args[5], "lane": args[6]]
if args.count >= 8 { content.userInfo["target"] = args[7] }
if let runID { content.userInfo["runID"] = runID }
content.sound = UNNotificationSound(named: UNNotificationSoundName("Glass.aiff"))

center.getNotificationSettings { settings in
    guard settings.authorizationStatus == .authorized else { exit(3) }
    let request = UNNotificationRequest(identifier: runID ?? lane, content: content, trigger: nil)
    center.add(request) { error in exit(error == nil ? 0 : 5) }
}

exitAfter(seconds: 4)
dispatchMain()
