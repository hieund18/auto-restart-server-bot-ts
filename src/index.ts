// src/index.ts
import { Telegraf, Context } from 'telegraf';
import axios, { AxiosError } from 'axios';
import * as fs from 'fs'; // <-- Đổi sang 'fs' (không dùng 'promises')
import * as path from 'path';
import { config } from 'dotenv';

// Nạp các biến môi trường từ file .env
config();

// --- 1. LẤY THÔNG TIN CẤU HÌNH ---
const {
    TELEGRAM_TOKEN,
    JENKINS_URL,
    JENKINS_USER,
    JENKINS_TOKEN,
    JENKINS_JOB,
    SUPER_ADMIN_ID
} = process.env;

if (!TELEGRAM_TOKEN || !SUPER_ADMIN_ID) {
    console.error("LỖI: TELEGRAM_TOKEN và SUPER_ADMIN_ID là bắt buộc!");
    process.exit(1);
}

const superAdminIdNum = parseInt(SUPER_ADMIN_ID, 10);
// Sửa đường dẫn file JSON để chạy trực tiếp (không dùng Docker)
const USERS_FILE = './data/authorized_users.json'; 

let authorizedUsers: Set<number> = new Set();

// --- 2. CÁC HÀM TRỢ GIÚP (ĐÃ CHUYỂN SANG ĐỒNG BỘ) ---

function loadAuthorizedUsers(): void { // <-- Xóa async
    try {
        // Kiểm tra file tồn tại (đồng bộ)
        if (fs.existsSync(USERS_FILE)) { 
            const data = fs.readFileSync(USERS_FILE, 'utf-8'); // <-- Dùng readFileSync
            const userIds: number[] = JSON.parse(data);
            authorizedUsers = new Set(userIds);
            console.log(`Đã tải ${authorizedUsers.size} user vào bộ nhớ.`);
        } else {
             // File không tồn tại
             console.warn("Không tìm thấy file user, bắt đầu với danh sách rỗng.");
             authorizedUsers = new Set();
        }
    } catch (error) {
        console.error("Lỗi khi đọc file user, bắt đầu với danh sách rỗng.", error);
        authorizedUsers = new Set();
    }
}

function saveAuthorizedUsers(): void { // <-- Xóa async
    try {
        const userIds = Array.from(authorizedUsers);
        const dir = path.dirname(USERS_FILE);

        // Đảm bảo thư mục tồn tại (đồng bộ)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Ghi file (đồng bộ)
        fs.writeFileSync(USERS_FILE, JSON.stringify(userIds, null, 2));
    } catch (error) {
        console.error("Lỗi nghiêm trọng khi lưu file user:", error);
    }
}

// Hàm kiểm tra quyền (không đổi)
function isAuthorized(userId: number | undefined): boolean {
    if (!userId) return false;
    if (userId === superAdminIdNum) return true;
    return authorizedUsers.has(userId);
}

// --- 3. KHỞI TẠO BOT (Telegraf v3) ---
// Telegraf v3 dùng 'new Telegraf()' thay vì 'new Telegraf.Telegraf()'
const bot = new Telegraf(TELEGRAM_TOKEN);

// --- 4. CÁC LỆNH BOT (Cú pháp Telegraf v3) ---

// Lệnh /myid
bot.command('myid', (ctx) => {
    const userId = ctx.from.id;
    ctx.replyWithMarkdown(`🆔 User ID của bạn là:\n\`${userId}\``);
});

// Lệnh /restart
bot.command('restart', async (ctx) => {
    if (!isAuthorized(ctx.from?.id)) {
        return ctx.reply("⛔ Bạn không có quyền thực hiện lệnh này.");
    }

    if (!JENKINS_URL || !JENKINS_USER || !JENKINS_TOKEN || !JENKINS_JOB) {
        return ctx.reply("❌ Lỗi cấu hình bot: Thiếu thông tin Jenkins (URL, USER, TOKEN, hoặc JOB).");
    }

    await ctx.reply("🚀 Đã nhận lệnh restart. Gửi yêu cầu đến Jenkins...");
    const triggerUrl = `${JENKINS_URL}/job/${JENKINS_JOB}/buildWithParameters`;

    try {
        const response = await axios.post(
            triggerUrl,
            null, 
            {
                auth: {
                    username: JENKINS_USER,
                    password: JENKINS_TOKEN
                },
                params: {
                    TELEGRAM_CHAT_ID: ctx.chat.id,
                    BOT_TOKEN: TELEGRAM_TOKEN // ⚠️ CẢNH BÁO: Vẫn là rủi ro bảo mật
                }
            }
        );

        if ([200, 201, 202].includes(response.status)) {
            await ctx.reply("✅ Jenkins đã nhận lệnh. Đang thực thi...");
        } else {
            await ctx.reply(`❌ Lỗi khi gọi Jenkins: ${response.status}\n${response.data}`);
        }
    } catch (error) {
        const axiosError = error as AxiosError;
        console.error("Lỗi khi gọi Jenkins:", axiosError.message);
        let errorMsg = axiosError.message;
        if (axiosError.response) {
            errorMsg = `Status: ${axiosError.response.status}\nData: ${JSON.stringify(axiosError.response.data)}`;
        }
        await ctx.reply(`❌ Lỗi nghiêm trọng khi kết nối Jenkins:\n${errorMsg}`);
    }
});

// Lệnh /adduser (Telegraf v3 dùng ctx.message.text)
bot.command('adduser', async (ctx) => {
    if (ctx.from.id !== superAdminIdNum) {
        return ctx.reply("⛔ Lệnh này chỉ dành cho Super Admin.");
    }
    
    // Telegraf v3 không có 'args', phải tự xử lý
    const args = ctx.message.text.split(' '); 
    if (args.length < 2) {
        return ctx.reply("Sử dụng: /adduser <user_id>");
    }

    const userIdToAdd = parseInt(args[1], 10);
    if (isNaN(userIdToAdd)) {
        return ctx.reply("ID không hợp lệ. Sử dụng: /adduser <user_id>");
    }

    if (authorizedUsers.has(userIdToAdd)) {
        return ctx.reply(`User ${userIdToAdd} đã có quyền.`);
    }

    authorizedUsers.add(userIdToAdd);
    saveAuthorizedUsers(); // <-- Chạy đồng bộ
    await ctx.reply(`✅ Đã thêm User ${userIdToAdd} vào danh sách được phép.`);
});

// Lệnh /deluser
bot.command('deluser', async (ctx) => {
    if (ctx.from.id !== superAdminIdNum) {
        return ctx.reply("⛔ Lệnh này chỉ dành cho Super Admin.");
    }

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply("Sử dụng: /deluser <user_id>");
    }

    const userIdToDel = parseInt(args[1], 10);
    if (isNaN(userIdToDel)) {
        return ctx.reply("ID không hợp lệ. Sử dụng: /deluser <user_id>");
    }

    if (authorizedUsers.has(userIdToDel)) {
        authorizedUsers.delete(userIdToDel);
        saveAuthorizedUsers(); // <-- Chạy đồng bộ
        await ctx.reply(`✅ Đã xóa User ${userIdToDel} khỏi danh sách.`);
    } else {
        await ctx.reply(`User ${userIdToDel} không tìm thấy trong danh sách.`);
    }
});

// Lệnh /listusers
bot.command('listusers', (ctx) => {
    if (ctx.from.id !== superAdminIdNum) {
        return ctx.reply("⛔ Lệnh này chỉ dành cho Super Admin.");
    }

    let message = `👑 *Super Admin:* \`${superAdminIdNum}\`\n\n`;
    if (authorizedUsers.size === 0) {
        message += "Danh sách user được cấp quyền khác đang trống.";
    } else {
        message += "Danh sách User được cấp quyền khác:\n";
        for (const userId of authorizedUsers) {
            message += `- \`${userId}\`\n`;
        }
    }
    ctx.replyWithMarkdown(message);
});

// --- 5. HÀM KHỞI ĐỘNG CHÍNH ---

function startBot() {
    // Tải danh sách user (chạy đồng bộ)
    loadAuthorizedUsers(); 
    
    console.log("Bot đang chạy...");
    
    // Khởi động bot (cú pháp v3)
    bot.launch();

    // Bắt tín hiệu tắt bot an toàn (Ctrl+C)
    process.once('SIGINT', () => bot.stop());
    process.once('SIGTERM', () => bot.stop());
}

startBot();