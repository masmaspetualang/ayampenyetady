require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cookieParser = require('cookie-parser');
const path = require('path');
const compression = require('compression');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Multer setup for temporary storage
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(compression()); // Compress all responses
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// Auth Middleware
const authenticate = async (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login.html');
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.redirect('/login.html');
    
    req.user = user;
    next();
};

// Routes
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// API Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .eq('password', password)
        .single();

    if (error) {
        console.error("Login Error Details:", error);
        return res.status(401).json({ success: false, message: error.message });
    }

    if (!user) {
        return res.status(401).json({ success: false, message: 'User tidak ditemukan' });
    }

    // Set simple cookie for demo
    res.cookie('user_role', user.role);
    res.cookie('username', user.username);
    res.json({ success: true, role: user.role });
});

// API Menu CRUD
app.get('/api/menu', async (req, res) => {
    const { data, error } = await supabase
        .from('menu_items')
        .select('*, categories(name)');
    if (error) return res.status(500).json(error);
    res.json(data);
});

app.post('/api/menu', async (req, res) => {
    const { name, price, category_id, image_url } = req.body;
    const { data, error } = await supabase
        .from('menu_items')
        .insert([{ name, price, category_id, image_url }]);
    if (error) return res.status(500).json(error);
    res.json({ success: true, data });
});

// API Upload Image to Supabase Storage
app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const file = req.file;
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${Date.now()}.${fileExt}`;
        const filePath = `${fileName}`;

        const { data, error } = await supabase.storage
            .from('menu-images')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                upsert: true
            });

        if (error) throw error;

        // Get Public URL
        const { data: { publicUrl } } = supabase.storage
            .from('menu-images')
            .getPublicUrl(filePath);

        res.json({ success: true, publicUrl });
    } catch (e) {
        console.error("Upload Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/menu/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase
        .from('menu_items')
        .delete()
        .eq('id', id);
    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

app.put('/api/menu/:id', async (req, res) => {
    const { id } = req.params;
    const { name, price, category_id, image_url } = req.body;
    
    let updateData = { name, price, category_id };
    if (image_url) updateData.image_url = image_url;

    const { data, error } = await supabase
        .from('menu_items')
        .update(updateData)
        .eq('id', id);
        
    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

app.delete('/api/transactions/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase
        .from('transactions')
        .delete()
        .eq('id', id);
    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

app.post('/api/transactions/bulk-delete', async (req, res) => {
    const { start_date, end_date } = req.body;
    const { error } = await supabase
        .from('transactions')
        .delete()
        .gte('created_at', start_date)
        .lte('created_at', end_date);
    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

app.get('/api/transactions', async (req, res) => {
    const { data, error } = await supabase
        .from('transactions')
        .select('*, users(username)')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json(error);
    res.json(data);
});

// API Transactions
app.post('/api/checkout', async (req, res) => {
    const { items, total_price, username, payment_method } = req.body;
    
    // Get user id first
    const { data: userData } = await supabase.from('users').select('id').eq('username', username).single();
    
    const { data: trans, error: transErr } = await supabase
        .from('transactions')
        .insert([{ user_id: userData.id, total_price, payment_method }])
        .select()
        .single();

    if (transErr) return res.status(500).json(transErr);

    const detailItems = items.map(item => ({
        transaction_id: trans.id,
        menu_item_id: item.id,
        quantity: item.quantity,
        subtotal: item.price * item.quantity
    }));

    const { error: detailErr } = await supabase.from('transaction_items').insert(detailItems);
    if (detailErr) return res.status(500).json(detailErr);

    res.json({ success: true, transaction_id: trans.id });
});

// API Monitoring Dashboard
app.get('/api/stats', async (req, res) => {
    try {
        const { data: trans, error } = await supabase.from('transactions').select('*');
        if (error) throw error;

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        const daily = trans
            .filter(t => new Date(t.created_at) >= today)
            .reduce((acc, curr) => acc + parseFloat(curr.total_price), 0);
            
        const total = trans.reduce((acc, curr) => acc + parseFloat(curr.total_price), 0);

        res.json({
            daily: `Rp ${daily.toLocaleString('id-ID')}`,
            weekly: `Rp ${(total * 0.4).toLocaleString('id-ID')}`, // Demo fallback
            monthly: `Rp ${total.toLocaleString('id-ID')}`,
            total_qty: trans.length
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
