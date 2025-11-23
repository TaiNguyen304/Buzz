// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Khởi tạo Socket.IO
const io = new Server(server, {
    cors: {
        // Cho phép frontend kết nối từ mọi nguồn
        origin: "*", // Để đơn giản cho việc test, bạn có thể để * hoặc giữ nguyên domain github của bạn
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const rooms = {};
const userIdMap = {}; // socketId -> userId

// --- UTILS ---

/** Tạo ID phòng 6 chữ số ngẫu nhiên */
function generateRoomId() {
    let roomId;
    do {
        roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms[roomId]);
    return roomId;
}

/** * Chuẩn bị và broadcast trạng thái phòng đến tất cả người tham gia
 * @param {string} roomId 
 */
function broadcastRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Chuyển đổi participants từ object sang array để dễ xử lý ở client
    const participantsArray = Object.values(room.participants);
    
    // Tạo data để gửi đi (loại bỏ hostId và userIdMap)
    const roomState = {
        roomId: roomId,
        bellStatus: room.bellStatus,
        bellOpenTimestamp: room.bellOpenTimestamp,
        bellSessionId: room.bellSessionId,
        lockedUsers: room.lockedUsers,
        options: room.options,
        participants: participantsArray,
        buzzes: room.buzzes
    };

    io.to(roomId).emit('roomStateUpdate', roomState);
}

// ==========================================================
// XỬ LÝ SOCKET.IO
// ==========================================================

io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // --- HOST EVENTS ---
    socket.on('createRoom', () => {
        const roomId = generateRoomId();
        const userId = `host-${socket.id}`;
        
        rooms[roomId] = {
            hostId: socket.id,
            bellStatus: 'locked',
            bellOpenTimestamp: null,
            bellSessionId: Date.now().toString(),
            lockedUsers: [], 
            options: { buzzCount: 'single', buzzMode: 'single-winner' }, 
            participants: {},
            buzzes: [],
            tempLockTimer: null // <--- MỚI: Biến lưu timer khóa tạm thời
        };
        
        // Thêm Host vào participants
        rooms[roomId].participants[socket.id] = { 
            userId: userId, 
            username: 'Host (Bạn)', 
            isHost: true 
        };
        userIdMap[socket.id] = userId;

        socket.join(roomId);
        console.log(`Room ${roomId} created by Host ${socket.id}`);
        socket.emit('roomCreated', { roomId });
        broadcastRoomState(roomId);
    });

    socket.on('hostUpdateRoom', ({ roomId, data }) => {
        const room = rooms[roomId];
        if (!room) return; 

        const isHost = (room.hostId === socket.id);
        const participant = room.participants[socket.id]; 
        const isManager = (participant && participant.isManager === true);

        if (!isHost && !isManager) {
            console.warn(`[AUTH] Rejected update from ${socket.id}. Not Host or Manager.`);
            return; 
        }

        // --- MỚI: Nếu Host can thiệp (Reset/Lock/Open), hủy bỏ bộ đếm tự động mở lại (nếu có) ---
        if (room.tempLockTimer) {
            clearTimeout(room.tempLockTimer);
            room.tempLockTimer = null;
        }
        // ---------------------------------------------------------------------------------------

        // Xử lý lệnh reset chuông
        if (data.reset) {
            room.bellStatus = 'locked';
            room.buzzes = [];
            room.bellOpenTimestamp = null;
            room.bellSessionId = Date.now().toString(); 
        }

        // Cập nhật trạng thái chuông
        if (data.bellStatus) {
            room.bellStatus = data.bellStatus;
            if (data.bellStatus.startsWith('open')) {
                // Chỉ cập nhật timestamp nếu timestamp chưa có (để giữ tính liên tục nếu muốn)
                // Hoặc luôn cập nhật mới khi Host bấm mở. Logic cũ là luôn cập nhật.
                room.bellOpenTimestamp = Date.now();
            } else if (data.bellStatus === 'locked') {
                // Host chủ động khóa
            }
        }

        // Cập nhật danh sách người bị khóa
        if (data.lockedUsers !== undefined) {
            room.lockedUsers = data.lockedUsers;
        }

        // Cập nhật tùy chọn chuông
        if (data.options) {
            room.options = { ...room.options, ...data.options };
        }

        broadcastRoomState(roomId);
    });
    
    // --- MANAGER EVENTS ---
    socket.on('joinRoomAsManager', ({ roomId, username, userId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('joinRoomError', { message: 'Phòng không tồn tại.' });
            return;
        }

        const usernameExists = Object.values(room.participants).some(p => p.username === username);
        if (usernameExists) {
            socket.emit('joinRoomError', { message: 'Username đã tồn tại trong phòng. Vui lòng chọn tên khác.' });
            return;
        }

        room.participants[socket.id] = { 
            userId: userId, 
            username: username, 
            isHost: false,
            isManager: true 
        };
        userIdMap[socket.id] = userId;

        socket.join(roomId);
        console.log(`Manager ${username} joined room ${roomId}`);

        socket.emit('joinedAsManager', { roomId, username, roomState: rooms[roomId] }); 
        broadcastRoomState(roomId);
    });


    // --- CONTESTANT EVENTS ---
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('joinRoomError', { message: 'Phòng không tồn tại.' });
            return;
        }
        
        const userId = socket.id; 
        userIdMap[socket.id] = userId;

        room.participants[socket.id] = { userId: userId, username: username, isHost: false, isManager: false };
        socket.join(roomId);
        console.log(`Contestant ${username} joined room ${roomId}`);

        socket.emit('roomJoined', { roomId, username, userId: userId });
        broadcastRoomState(roomId);
    });

    socket.on('buzz', ({ roomId, username, userId, bellSessionId }) => {
        const room = rooms[roomId];
        // Kiểm tra cơ bản
        if (!room || room.bellStatus.startsWith('locked') || room.bellSessionId !== bellSessionId) return;

        const participant = room.participants[socket.id];
        if (!participant) return;

        if (room.lockedUsers.includes(participant.userId)) {
            console.log(`[BELL LOCK] User ${username} is locked and cannot buzz.`);
            return; 
        }

        // 1. Kiểm tra Buzz Count 
        const iHaveBuzzed = room.buzzes.some(buzz => buzz.userId === userId && buzz.bellSessionId === bellSessionId);
        if (room.options.buzzCount === 'single' && iHaveBuzzed) {
            console.log(`User ${username} tried to buzz again (single buzz mode).`);
            return;
        }

        // 2. Ghi nhận Buzz
        const buzzTime = (Date.now() - room.bellOpenTimestamp) / 1000;
        
        room.buzzes.push({ 
            userId: userId, 
            username: username, 
            time: buzzTime, 
            bellSessionId: bellSessionId 
        });

        console.log(`Buzz received from ${username} at ${buzzTime.toFixed(3)}s`);

        // 3. Xử lý Buzz Mode
        if (room.options.buzzMode === 'single-winner') {
            
            // --- LOGIC MỚI: Xử lý 5 giây Cooldown ---
            // Điều kiện: Single Winner + Multiple Buzz + Open Infinite
            const isMultipleBuzz = room.options.buzzCount === 'multiple';
            const isInfiniteOpen = room.bellStatus === 'open_infinite'; // Lúc bấm thì trạng thái vẫn đang là open_infinite

            if (isMultipleBuzz && isInfiniteOpen) {
                // a. Khóa tạm thời
                room.bellStatus = 'locked_winner';
                console.log(`Single-winner (Multi-buzz): Bell temp locked for 5s by ${username}`);
                
                // b. Broadcast trạng thái khóa ngay lập tức
                broadcastRoomState(roomId);

                // c. Đặt hẹn giờ mở lại
                if (room.tempLockTimer) clearTimeout(room.tempLockTimer);
                
                room.tempLockTimer = setTimeout(() => {
                    // Kiểm tra xem phòng còn tồn tại và trạng thái vẫn đang bị khóa (bởi lượt bấm này) hay không
                    if (rooms[roomId] && rooms[roomId].bellStatus === 'locked_winner') {
                        rooms[roomId].bellStatus = 'open_infinite';
                        // Lưu ý: Không reset buzzes, không reset bellSessionId, 
                        // giữ nguyên bellOpenTimestamp để tính thời gian tiếp tục
                        
                        console.log(`Room ${roomId} auto-reopened after 5s.`);
                        broadcastRoomState(roomId);
                        rooms[roomId].tempLockTimer = null;
                    }
                }, 5000); // 5000ms = 5 giây

            } else {
                // Logic cũ: Khóa hẳn
                room.bellStatus = 'locked_winner';
                console.log(`Single-winner mode: Bell locked permanently by ${username}`);
                broadcastRoomState(roomId);
            }

        } else {
            // Chế độ All Buzz: Không làm gì cả, chỉ cập nhật danh sách
            broadcastRoomState(roomId);
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        
        for (const roomId in rooms) {
            if (rooms[roomId].hostId === socket.id) {
                console.log(`Host of room ${roomId} disconnected. Room deleted.`);
                io.to(roomId).emit('roomClosed', { message: 'Host đã rời phòng.' });
                
                // Xóa timer nếu có
                if (rooms[roomId].tempLockTimer) clearTimeout(rooms[roomId].tempLockTimer);
                
                delete rooms[roomId];
                delete userIdMap[socket.id];
                return;
            }
            
            if (rooms[roomId].participants[socket.id]) {
                const username = rooms[roomId].participants[socket.id].username;
                const role = rooms[roomId].participants[socket.id].isManager ? 'Manager' : 'Contestant';

                console.log(`${role} ${username} in room ${roomId} disconnected.`);
                delete rooms[roomId].participants[socket.id];
                delete userIdMap[socket.id];
                
                broadcastRoomState(roomId);
                return;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});