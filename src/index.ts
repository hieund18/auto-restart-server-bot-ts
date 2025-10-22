// src/index.ts
import { Telegraf, Context } from 'telegraf';
import axios from 'axios';
import * as fs from 'fs/promises'; // Dùng fs bất đồng bộ
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

// Kiểm tra các biến quan trọng
if (!TELEGRAM_TOKEN || !SUPER_ADMIN_ID) {
    console.error("LỖI: TELEGRAM_TOKEN và SUPER_ADMIN_ID là bắt buộc!");
    process.exit(1);
}

const superAdminIdNum = parseInt(SUPER_ADMIN_ID, 10);
const USERS_FILE = './data/authorized_users.json'; // Đường dẫn trong Docker

// Dùng Set để lưu trữ user, tốc độ truy cập nhanh hơn
let authorizedUsers: Set<number> = new Set();

// --- 2. CÁC HÀM TRỢ GIÚP (ĐỌC/GHI FILE) ---

async function loadAuthorizedUsers(): Promise<void> {
    try {
        // Kiểm tra file tồn tại
        await fs.access(USERS_FILE);
        const data = await fs.readFile(USERS_FILE, 'utf-8');
        const userIds: number[] = JSON.parse(data);
        authorizedUsers = new Set(userIds);
        console.log(`Đã tải ${authorizedUsers.size} user vào bộ nhớ.`);
    } catch (error) {
        // Lỗi (ví dụ: file không tồn tại), bắt đầu với danh sách rỗng
        console.warn("Không tìm thấy file user hoặc file bị lỗi, bắt đầu với danh sách rỗng.");
        authorizedUsers = new Set();
    }
}

async function saveAuthorizedUsers(): Promise<void> {
    try {
        const userIds = Array.from(authorizedUsers);
        // Đảm bảo thư mục /data tồn tại
        await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
        // Ghi file
        await fs.writeFile(USERS_FILE, JSON.stringify(userIds, null, 2));
    } catch (error) {
        console.error("Lỗi nghiêm trọng khi lưu file user:", error);
    }
}

// Hàm kiểm tra quyền (đã tối ưu)
function isAuthorized(userId: number | undefined): boolean {
    if (!userId) return false;
    if (userId === superAdminIdNum) return true;
    return authorizedUsers.has(userId);
}

// --- 3. KHỞI TẠO BOT ---
const bot = new Telegraf(TELEGRAM_TOKEN);

// --- 4. CÁC LỆNH BOT ---

// Lệnh /myid
bot.command('myid', (ctx) => {
    const userId = ctx.from.id;
    // Dùng replyWithMarkdownV2 an toàn hơn
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
            null, // Không có body
            {
                // Dùng Basic Auth
                auth: {
                    username: JENKINS_USER,
                    password: JENKINS_TOKEN
                },
                // Các tham số truyền qua URL
                params: {
                    TELEGRAM_CHAT_ID: ctx.chat.id,
                    BOT_TOKEN: TELEGRAM_TOKEN // ⚠️ CẢNH BÁO: Đây là rủi ro bảo mật
                }
            }
        );

        if ([200, 201, 202].includes(response.status)) {
            await ctx.reply("✅ Jenkins đã nhận lệnh. Đang thực thi...");
        } else {
            await ctx.reply(`❌ Lỗi khi gọi Jenkins: ${response.status}\n${response.data}`);
        }
    } catch (error: any) {
        console.error("Lỗi khi gọi Jenkins:", error);
        let errorMsg = error.message;
        if (error.response) {
            // Hiển thị lỗi từ Jenkins nếu có
            errorMsg = `Status: ${error.response.status}\nData: ${JSON.stringify(error.response.data)}`;
        }
        await ctx.reply(`❌ Lỗi nghiêm trọng khi kết nối Jenkins:\n${errorMsg}`);
    }
});

// Lệnh /adduser
bot.command('adduser', async (ctx) => {
    if (ctx.from.id !== superAdminIdNum) {
        return ctx.reply("⛔ Lệnh này chỉ dành cho Super Admin.");
    }

    const args = ctx.message.text.split(' '); // Tách lệnh
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
    await saveAuthorizedUsers(); // Lưu vào file
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
        await saveAuthorizedUsers();
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

async function startBot() {
    // Tải danh sách user trước khi khởi động
    await loadAuthorizedUsers();
    
    console.log("Bot đang chạy...");
    
    // Khởi động bot
    bot.launch();

    // Bắt tín hiệu tắt bot an toàn (Ctrl+C)
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

startBot();