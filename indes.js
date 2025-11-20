require("dotenv").config();
const { Telegraf } = require("telegraf");
const FormData = require("form-data");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const START_TASK_URL = process.env.START_TASK_URL;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in environment");
if (!START_TASK_URL) throw new Error("Missing START_TASK_URL in environment");

const bot = new Telegraf(BOT_TOKEN);

bot.on("document", async (ctx) => {
    try {
        const file = ctx.message.document;

        if (!file.file_name.match(/\.(ppt|pptx)$/i)) {
            return ctx.reply("❌ Only PPT/PPTX files are allowed.");
        }

        await ctx.reply("⏳ Converting your PPT… (جاري تحويل الملف)");
        
        const fileInfo = await ctx.telegram.getFile(file.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        const tgRes = await axios.get(fileUrl, { responseType: "arraybuffer" });

        const fileBuffer = Buffer.from(tgRes.data);

        const startResp = await axios.post(START_TASK_URL);
        const { server, task, token } = startResp.data;

        const form = new FormData();
        form.append("task", task);
        form.append("file", fileBuffer, file.file_name);

        const uploadResp = await axios.post(
            `https://${server}/v1/upload`,
            form,
            { headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` } }
        );

        const serverFilename = uploadResp.data.server_filename;

        const processResp = await axios.post(
            `https://${server}/v1/process`,
            {
                task,
                tool: "officepdf",
                files: [{
                    server_filename: serverFilename,
                    filename: file.file_name
                }]
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const downloadResp = await axios.get(
            `https://${server}/v1/download/${task}`,
            { responseType: "arraybuffer", headers: { Authorization: `Bearer ${token}` } }
        );

        const pdfBuffer = Buffer.from(downloadResp.data);

        const outName = file.file_name.replace(/\.(ppt|pptx)$/i, ".pdf");

        await ctx.replyWithDocument({ source: pdfBuffer, filename: outName });
        await ctx.reply("✅ Converted successfully!");

    } catch (err) {
        console.error("BOT ERROR:", err.response?.data || err.message);
        ctx.reply("❌ Error: " + (err.response?.data?.error?.message || err.message));
    }
});

bot.launch();
console.log("🤖 Bot is running...");
