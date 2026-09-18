# Đánh giá paseo-room theo mô hình agent orchestration của Demonthorn

- **Phạm vi:** HEAD `086c89a` (6 commit sau `v0.1.0-alpha.6`), ngày 2026-09-17.
- **Cách đánh giá:**
  - đọc toàn bộ `src/`, `src/room/prompts/`, `docs/`, test và CI;
  - chạy `npm run verify` (xanh: 131 test + 1 test gói);
  - chạy `paseo-room verify` trên room đang cài (alpha.6);
  - so model catalog của room với catalog hiện tại của Codex;
  - đọc source Codex (`ConfigProfile`) để xác định thứ tự ưu tiên của profile.

## Kết luận nhanh

- **Tầng hạ tầng làm rất tốt:** control plane duy nhất, cô lập từng seat, pin ở cấp provider, và phát hiện drift.
- **Tầng hành vi (role contract) mạnh ở phần authority, nhưng thiếu phần tạo ra giá trị cốt lõi của mô hình:**
  - Peer có nhận định độc lập;
  - chống việc Lead giải sẵn lời giải trong brief (pre-solving);
  - Supervisor đóng vai quan sát và quản trị quy trình.
- **Có ba lỗ hổng kỹ thuật nên xử lý trước:**
  - skill điều phối Paseo lọt vào Peer;
  - cấu hình của operator có thể mở lại đường điều phối;
  - model catalog đóng băng system prompt gốc (base prompt) của Codex.

## Điểm mạnh

1. **Một control plane, đóng nhiều lớp.**
   - Codex: `[agents].enabled=false`, tắt hai feature flag multi-agent, và scrub `multi_agent_version` trong catalog.
   - Claude: `disallowedTools`; pin kép env và settings cho Agent View/Workflows; `crossSessionInbound: "refuse"`; không link `agents/` và `workflows/`.
   - Pi: argv chặt, `PI_MCP_CONFIG_MODE=exclusive`, và probe offline xác thực `/mcp` được nạp đúng từ adapter.
2. **Quyền gắn vào năng lực, không chỉ vào lời dặn.** `paseoTools.enabled` được đặt riêng cho từng provider, và chỉ có một nguồn là `ROLE_PASEO_TOOLS`.
3. **Pin ở cấp provider có kiểm tra.** `providerMatches` so sánh `params`, `disallowedTools`, env và argv, nên `verify` bắt được khi một pin bị gỡ.
4. **Role contract được cộng thêm, không thay base prompt.** Contract đi qua `developer_instructions`, `CLAUDE.md` hoặc `--append-system-prompt`; `model_instructions_file` không bị động tới. (Ngoại lệ ngầm: xem mục C3.)
5. **Tách đúng ba lớp instruction.**
   - Contract nằm trong `prompts/contract/`.
   - Workspace protocol mặc định (WP) áp dụng theo từng điểm: `WORKSPACE_PROTOCOL.md` ở gốc repo thắng ở điểm nào nó có nói tới.
   - Brief là việc của Lead.
   - Peer không nhận lớp workspace (kể cả Topology), nhất quán với luật No Orchestration; Lead trích các ràng buộc liên quan vào brief.
6. **Contract kiểm chứng được.**
   - Markdown là nguồn duy nhất; loader kiểm tra cấu trúc heading.
   - Test khẳng định thứ tự section, output giống hệt từng byte giữa các lần render, và file khớp một-một với manifest.
   - Có test chạy trên gói đã pack.
7. **Nhận diện seat dựa trên bằng chứng.** Lead/Supervisor chép đủ trường của profile khi tạo seat, rồi kiểm tra provider, workspace, mode và parent. Giới hạn được nêu thật: Paseo không lưu profileId, và quy trình không được daemon cưỡng chế.
8. **An toàn khi vận hành.**
   - Mặc định là dry-run.
   - Dùng `lstat` để chặn đường dẫn bị symlink trỏ đi nơi khác.
   - Credential chỉ được giữ nguyên, không bao giờ đọc nội dung.
   - `remove` dừng an toàn khi không dọn được phía Paseo.
   - Ba loại khẳng định được tách bạch: cấu hình đã đúng, runtime đã nạp cấu hình, model đã tuân theo.
9. **Đơn giản có chủ đích.**
   - Khoảng 2,4 nghìn dòng TypeScript, không có cơ chế transaction; setup hỏng thì chạy lại setup.
   - Gate 5 bước: typecheck → lint → test → build → test gói.
   - CI chạy trên Linux và macOS; publish qua OIDC trusted publishing.
10. **`docs/design.md` ghi rõ lý do.** Mỗi override được giải thích bằng lỗi cụ thể đã gặp, kèm những chỗ cố ý lệch khỏi mô hình.

## Cần cải tiến

### P1: ảnh hưởng trực tiếp tới invariant

**C1. Skill điều phối Paseo lọt vào Peer.**

- **Vấn đề:**
  - Thư mục `skills` được link nguyên cho mọi role.
  - Trên room đang cài, Peer Codex và Peer Claude thấy `paseo`, `paseo-advisor`, `paseo-committee`, `paseo-handoff`, `paseo-help`, `paseo-plugin`.
  - Skill `paseo` dạy cả MCP tool lẫn CLI (`paseo run`, `paseo send`). Peer không có MCP tool nhưng có shell full-access, nên vẫn còn đường tạo agent qua CLI.
  - Điều này trái với luật "Capability shapes behaviour" (`docs/orchestration-model.md` §4) và luật No Orchestration.
- **Đề xuất:**
  - Với Peer, link từng skill một thay vì cả thư mục, và loại bộ skill do Paseo quản lý (`paseo*`); thêm test.
  - Cân nhắc thêm một pin env cho Peer để CLI `paseo` không kết nối được daemon (cần kiểm chứng CLI hoạt động thế nào khi chạy trong agent). Ghi rõ đây là rào cản tránh vô tình, không phải sandbox.

**C2. Cấu hình của operator có thể mở lại đường điều phối.**

- **Vấn đề:**
  - Profile Codex đang hoạt động được phép đặt `model_catalog_json` và `features`, nhưng `renderRoleConfig` chỉ ghi đè sandbox/approval trong profile. Một profile của operator có thể thay catalog đã scrub hoặc bật lại multi-agent.
  - MCP server của operator được chép nguyên vào mọi seat: `mcp_servers` (Codex), `.claude.json#mcpServers` (Claude), `mcp.json` (Pi). Nếu operator tự khai báo một MCP server Paseo, Peer có room tools bất kể `paseoTools.enabled=false`.
- **Đề xuất:**
  - Ghi thêm `model_catalog_json` và các cờ multi-agent vào profile đang hoạt động, như đã làm với sandbox/approval.
  - `setup`/`verify` báo lỗi khi seat Peer có MCP server trỏ tới Paseo (so tên, command hoặc url).

**C3. Model catalog đóng băng base prompt, trái với `docs/design.md` §6.**

- **Vấn đề:**
  - Catalog sinh ra chứa `base_instructions` và `instructions_template` của từng model (ví dụ `gpt-6-astra` dài 21 nghìn ký tự). Như vậy room vẫn ngầm lưu một bản sao prompt vendor tại thời điểm setup.
  - Trên room đang cài, prompt của `gpt-5.6-luna` đã lệch so với catalog hiện tại của Codex.
  - `verify` có báo drift file nhưng không nói nguyên nhân.
- **Đề xuất:**
  - Ghi rõ hiện tượng này trong README/design.
  - Lưu phiên bản Codex vào `room.json` và đưa cảnh báo riêng: "catalog/phiên bản Codex đã đổi, hãy chạy lại setup".
  - Nhắc chạy lại setup sau mỗi lần nâng cấp Codex.

### P2: độ trung thành với triết lý của mô hình

**C4. Contract thiếu phần "Peer là đồng nghiệp độc lập".**

- **Vấn đề:**
  - Không có câu nào trong `prompts/` nói rằng:
    - brief nêu outcome và evidence, không nêu sẵn lời giải;
    - plan và danh sách file chỉ là tạm thời;
    - Peer tự hình thành nhận định kỹ thuật;
    - đồng thuận là hợp lệ khi có evidence, và không phản đối cho có.
  - `docs/orchestration-model.md` §3 yêu cầu role profile mang các "anti-pattern guards", nhưng contract không có.
  - Cụm "stable contract and invariants" trong Complete Peer Brief dễ bị hiểu thành việc giải sẵn lời giải.
- **Đề xuất:** thêm một câu cho Lead trong Complete Peer Brief và một section ngắn "Independent Judgment" cho Peer, kèm test.

**C5. Supervisor bị thu hẹp thành "routing seat".**

- **Vấn đề:**
  - Mô hình (§2) giao cho Supervisor quan sát luồng Lead–Peer, phát hiện authority gradient, framing capture, moving scope, polling, verification yếu, rồi góp ý cho Lead.
  - Contract Supervisor không có nhiệm vụ quan sát, không có notebook ghi cơ chế nhân quả, không có vòng cải tiến protocol.
  - Trong khi đó, `lead-discovery-and-recovery` là 52 dòng thủ tục gọi API luôn nằm trong context.
- **Đề xuất:**
  - Thêm section "Observation and Advice": quan sát dựa trên bằng chứng, hỏi Lead, ghi cơ chế vào notebook, đề xuất sửa protocol khi một mẫu lặp lại.
  - Chuyển thủ tục discovery chi tiết sang một skill chỉ Supervisor và Lead dùng; contract chỉ giữ bất biến.

**C6. Luật "tối đa một Peer ghi trên toàn project" chặt hơn mô hình.**

- **Vấn đề:**
  - Mô hình quy định mỗi phạm vi đang thay đổi có một người ghi, và các writer chạy đồng thời phải dùng worktree riêng.
  - Contract giới hạn một Peer ghi cho cả project, và protocol của repo không được nới luật này.
  - Contract không nhắc gì tới worktree (`create_workspace`, `isolation: worktree`).
- **Đề xuất:**
  - Giữ mặc định một writer.
  - Cho phép protocol của repo nới lỏng khi các scope tách rời và mỗi writer có worktree riêng.
  - Thêm một câu về worktree cho Lead.

**C7. Việc chọn model/effort bị khóa bởi quy trình chép profile.**

- **Vấn đề:**
  - Peer Seat Lifecycle yêu cầu chép nguyên `thinkingOptionId` từ profile, nên Lead không có chỗ chọn model/effort theo rủi ro của task.
  - Mô hình (§3) đặt chính sách model/effort trong workspace protocol.
  - Bước kiểm tra seat chỉ cần provider, workspace và mode.
- **Đề xuất:**
  - Nêu rõ provider và mode là bất biến.
  - Model và thinking chỉ là mặc định; Lead được đổi theo protocol của repo, nhưng không được lên mức tự delegation (`ultra`, `ultracode`).

### P3: vận hành và bảo trì

**C8. Không nhận diện được phiên bản contract.**

- **Vấn đề:**
  - HEAD có thay đổi nội dung model-facing (bỏ mã `RC-xxx`, chuyển sang heading ngữ nghĩa), nhưng `package.json` vẫn là `0.1.0-alpha.6`, nên `room.json` không phân biệt được hai bản contract.
  - Mã ổn định như `RC-xxx` cũng hữu ích để trích dẫn trong notebook và trong protocol của repo.
- **Đề xuất:**
  - Bump version mỗi khi đổi prompt, và ghi digest của contract vào `room.json`.
  - Cân nhắc giữ lại mã ngắn, ổn định trong heading.

**C9. `thinkingOptionId` không được kiểm tra.**

- **Vấn đề:** operator có thể chọn `ultra`/`ultracode` (tự delegation) mà không có cảnh báo nào.
- **Đề xuất:** `verify` cảnh báo khi một profile của room đang ở mức cao nhất đó.

**C10. MCP của Claude chỉ được seed một lần.**

- **Vấn đề:** `.claude.json` được tạo một lần (`once`), nên MCP user-scope thêm sau không vào seat, và setup không báo gì.
- **Đề xuất:** `verify` so danh sách tên server và cảnh báo khi lệch.

**C11. Ghi file không nguyên tử.**

- **Vấn đề:**
  - `applyEntries` xóa (`rm -rf`) rồi mới ghi file hoặc tạo symlink. Nếu tiến trình dừng giữa chừng, seat mất config.
  - Nếu tại vị trí một link có thư mục thật, thư mục đó bị xóa mà không báo.
- **Đề xuất:**
  - Ghi ra file tạm rồi `rename` (cách này không phải cơ chế transaction).
  - Báo lỗi thay vì xóa khi đường dẫn có kiểu bất ngờ.

**C12. Kênh đưa contract vào Claude yếu.**

- **Vấn đề:** `CLAUDE.md` là memory và bị `CLAUDE.md` của dự án làm loãng; `docs/design.md` đã thừa nhận điểm này.
- **Đề xuất:** thử truyền append system prompt qua `command` của provider giống Pi. Nếu Paseo và Claude hỗ trợ thì chuyển sang cách đó.

**C13. Tài liệu dài và lặp.**

- **Vấn đề:** README (448 dòng), `docs/design.md` (503) và `docs/orchestration-model.md` (445) đều mô tả lại thủ tục Lead discovery, trùng với contract.
- **Đề xuất:** giữ một nguồn duy nhất (contract hoặc skill); các nơi khác chỉ link tới.

## Thứ tự đề xuất

1. **C1 + C2 + C3:** một thay đổi về "Peer capability hygiene" và nói thật về catalog. Đây là các lỗ hổng làm yếu invariant một control plane.
2. **C4 + C5:** bổ sung contract để giữ nhận định độc lập và vai trò quản trị quy trình, kèm test cho từng câu mới.
3. **C6 + C7:** mở chỗ cho protocol của repo nới số writer và chọn model/effort.
4. **C8–C13:** cải thiện dần khi có dịp chạm vào khu vực liên quan.
