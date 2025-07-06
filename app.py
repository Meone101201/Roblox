
from flask import Flask, render_template, request, jsonify, session
import mysql.connector
from mysql.connector import Error
from werkzeug.security import generate_password_hash, check_password_hash
import json
import random
from datetime import datetime, timedelta
from flask_apscheduler import APScheduler

class Config:
    SCHEDULER_API_ENABLED = True

app = Flask(__name__)
app.config.from_object(Config())
app.secret_key = 'your_super_secret_key_change_me_please'

DB_CONFIG = {'host': 'localhost', 'user': 'root', 'password': '', 'database': 'plant_game_db'}
PLANT_TYPES, FERTILIZER_TYPES, FRUIT_TYPES, WEATHER_TYPES, WEATHER_COMBINATIONS = {}, {}, {}, {}, {}
PLOT_COSTS = {2: 5000, 3: 15000, 4: 50000}
GLOBAL_WEATHER_STATE = []
LAST_GLOBAL_WEATHER_UPDATE_MINUTE = -1

def get_db_connection():
    try:
        return mysql.connector.connect(**DB_CONFIG)
    except Error as e:
        print(f"DB Connection Error: {e}")
        return None

def load_game_data():
    global PLANT_TYPES, FERTILIZER_TYPES, FRUIT_TYPES, WEATHER_TYPES, WEATHER_COMBINATIONS
    with get_db_connection() as conn:
        with conn.cursor(dictionary=True) as cursor:
            cursor.execute("SELECT * FROM plant_types")
            PLANT_TYPES = {p['id']: p for p in cursor.fetchall()}
            cursor.execute("SELECT * FROM fertilizer_types")
            FERTILIZER_TYPES = {f['id']: f for f in cursor.fetchall()}
            cursor.execute("SELECT * FROM fruit_types")
            FRUIT_TYPES = {f['id']: f for f in cursor.fetchall()}
            cursor.execute("SELECT * FROM weather_types")
            WEATHER_TYPES = {w['id']: w for w in cursor.fetchall()}
            cursor.execute("SELECT * FROM weather_combinations")
            combo_data = cursor.fetchall()
            for combo in combo_data:
                combo['weather_type_ids'] = json.loads(combo['weather_type_ids'])
                WEATHER_COMBINATIONS[combo['id']] = combo
    print("All game data loaded.")

load_game_data()

def db_execute(query, params=(), commit=False):
    with app.app_context():
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                try:
                    cursor.execute(query, params)
                except Exception as e:
                    print(f"DB Execute Error: {e}")
                    conn.rollback()
                    return False
                if commit:
                    conn.commit()
                    return True

def db_fetch_one(query, params=()):
    with app.app_context():
        with get_db_connection() as conn:
            with conn.cursor(dictionary=True) as cursor:
                try:
                    cursor.execute(query, params)
                    return cursor.fetchone()
                except Exception as e:
                    return None

def db_fetch_all(query, params=()):
    with app.app_context():
        with get_db_connection() as conn:
            with conn.cursor(dictionary=True) as cursor:
                try:
                    cursor.execute(query, params)
                    return cursor.fetchall()
                except Exception as e:
                    return []

def run_global_game_updates():
    with app.app_context():
        print(f"⏱  Running background game update at {datetime.now().strftime('%H:%M:%S')}")
        user_ids = [u['id'] for u in db_fetch_all("SELECT id FROM users")]
        print(f"Found {len(user_ids)} users to update.")
        for uid in user_ids:
            try:
                perform_game_updates(uid)
            except Exception as e:
                print(f"❌ Error updating user {uid}: {e}")
        print("✅ Background update complete.")

scheduler = APScheduler()
scheduler.init_app(app)
scheduler.start()

if scheduler.get_job('update_game_every_2min'):
    scheduler.remove_job('update_game_every_2min')

scheduler.add_job(
    id='update_game_every_2min',
    func=run_global_game_updates,
    trigger='interval',
    minutes=1
)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/ui/<fragment_name>')
def get_ui_fragment(fragment_name):
    return render_template(f'game_ui_fragments/{fragment_name}.html')

@app.before_request
def require_login():
    allowed = ['index', 'get_ui_fragment', 'login', 'register', 'check_session', 'static', 'favicon.ico']
    if request.endpoint in allowed or request.path.startswith('/static/'):
        return
    if 'user_id' not in session:
        return jsonify(success=False, message='Authentication Required'), 401

@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    if not (username and password):
        return jsonify(success=False, message='Missing credentials'), 400
    if db_fetch_one("SELECT id FROM users WHERE username=%s", (username,)):
        return jsonify(success=False, message='Username exists'), 409
    hashed_pass = generate_password_hash(password)
    db_execute("INSERT INTO users (username, password) VALUES (%s, %s)", (username, hashed_pass), commit=True)
    user = db_fetch_one("SELECT id FROM users WHERE username=%s", (username,))
    session['user_id'] = user['id']
    db_execute("INSERT INTO user_plots (user_id, plot_number) VALUES (%s, 1)", (user['id'],), commit=True)
    db_execute("INSERT INTO inventory (user_id, item_type, item_id, quantity) VALUES (%s, 'seed', 3, 1)", (user['id'],), commit=True)
    return jsonify(success=True)

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username, password = data.get('username'), data.get('password')
    user = db_fetch_one("SELECT id, password FROM users WHERE username=%s", (username,))
    if user and check_password_hash(user['password'], password):
        session['user_id'] = user['id']
        return jsonify(success=True)
    return jsonify(success=False, message='Invalid credentials'), 401

@app.route('/api/logout')
def logout():
    session.clear()
    return jsonify(success=True)

@app.route('/api/check_session')
def check_session():
    return jsonify(logged_in='user_id' in session)

@app.route('/api/get_game_state')
def get_game_state():
    user_id = session.get('user_id')
    perform_game_updates(user_id)
    user_data = db_fetch_one("SELECT username, money FROM users WHERE id=%s", (user_id,))
    if not user_data:
        session.clear()
        return jsonify(success=False, message='User not found'), 404
    plots = db_fetch_all("SELECT * FROM user_plots WHERE user_id=%s ORDER BY plot_number", (user_id,))
    for plot in plots:
        plot['fruits'] = db_fetch_all("SELECT * FROM user_fruits WHERE plot_id=%s AND harvested=FALSE", (plot['id'],)) if plot.get('plant_type_id') else []
    inventory_fruits = db_fetch_all('''
        SELECT uf.*, ft.color_name, ft.image_suffix, pt.image_prefix, pt.name as plant_name
        FROM user_fruits uf
        JOIN fruit_types ft ON uf.fruit_type_id = ft.id
        JOIN plant_types pt ON ft.plant_type_id = pt.id
        WHERE uf.user_id = %s AND uf.plot_id IS NULL AND uf.harvested = FALSE
        ORDER BY uf.created_at DESC
    ''', (user_id,))
    state = {
        'user': user_data,
        'plots': plots,
        'inventory': db_fetch_all("SELECT * FROM inventory WHERE user_id=%s", (user_id,)),
        'inventory_fruits': inventory_fruits,
        'global_weather': GLOBAL_WEATHER_STATE,
        'game_data': {
            'plant_types': PLANT_TYPES,
            'fertilizer_types': FERTILIZER_TYPES,
            'fruit_types': FRUIT_TYPES,
            'weather_types': WEATHER_TYPES,
            'weather_combinations': WEATHER_COMBINATIONS,
            'plot_costs': PLOT_COSTS
        }
    }
    return jsonify(success=True, state=state)

@app.route('/api/update_game')
def update_game():
    perform_game_updates(session['user_id'])
    return get_game_state()

def perform_game_updates(user_id):
    global GLOBAL_WEATHER_STATE, LAST_GLOBAL_WEATHER_UPDATE_MINUTE
    current_time = datetime.now()
    plots_to_update = db_fetch_all('''
        SELECT p.*, pt.max_growth_stage, pt.harvest_type, pt.growth_time_per_stage_seconds
        FROM user_plots p
        JOIN plant_types pt ON p.plant_type_id = pt.id
        WHERE p.user_id=%s AND p.plant_type_id IS NOT NULL AND p.growth_stage < pt.max_growth_stage
    ''', (user_id,))
    for plot in plots_to_update:
        base_time_elapsed = (current_time - plot['planted_at']).total_seconds()
        total_effective_time = base_time_elapsed + plot.get('growth_boost_seconds', 0)
        completed_stages = total_effective_time // plot['growth_time_per_stage_seconds']
        new_stage = min(plot['max_growth_stage'], int(completed_stages) + 1)
        if new_stage > plot['growth_stage']:
            db_execute("UPDATE user_plots SET growth_stage=%s, last_growth_update=%s WHERE id=%s", (new_stage, current_time, plot['id']), commit=True)
    if current_time.minute % 5 == 0 and LAST_GLOBAL_WEATHER_UPDATE_MINUTE != current_time.minute:
        GLOBAL_WEATHER_STATE = [w for w_id, w in WEATHER_TYPES.items() if random.random() < w['spawn_rate']]
        LAST_GLOBAL_WEATHER_UPDATE_MINUTE = current_time.minute
        print(f"--- Global weather updated at minute {LAST_GLOBAL_WEATHER_UPDATE_MINUTE}: {[w['name'] for w in GLOBAL_WEATHER_STATE]} ---")
    perennial_plots = db_fetch_all('''
        SELECT p.* FROM user_plots p JOIN plant_types pt ON p.plant_type_id = pt.id
        WHERE p.user_id=%s AND pt.harvest_type = 'perennial' AND p.growth_stage >= 16
    ''', (user_id,))
    for plot in perennial_plots:
        current_fruits = db_fetch_all("SELECT * FROM user_fruits WHERE plot_id=%s AND harvested=FALSE", (plot['id'],))
        if len(current_fruits) < 10:
            last_attempt_time = plot.get('last_spawn_attempt_at')
            if current_time.minute % 2 == 0 and (not last_attempt_time or last_attempt_time.minute != current_time.minute):
                print(f"OK to spawn for perennial plot {plot['id']} at minute {current_time.minute}.")
                spawn_new_fruit(user_id, plot)
    single_harvest_plots = db_fetch_all('''
        SELECT p.* FROM user_plots p JOIN plant_types pt ON p.plant_type_id = pt.id
        WHERE p.user_id = %s
          AND pt.harvest_type = 'single_harvest'
          AND p.growth_stage = pt.max_growth_stage
          AND NOT EXISTS (SELECT 1 FROM user_fruits uf WHERE uf.plot_id = p.id AND uf.harvested = FALSE)
    ''', (user_id,))
    for plot in single_harvest_plots:
        print(f"Transforming single-harvest plot {plot['id']} into a fruit.")
        spawn_new_fruit(user_id, plot)
    plots_with_fruits = db_fetch_all("SELECT id FROM user_plots WHERE user_id=%s AND plant_type_id IS NOT NULL", (user_id,))
    global_weather_ids = {w['id'] for w in GLOBAL_WEATHER_STATE}
    for plot in plots_with_fruits:
        current_fruits = db_fetch_all("SELECT * FROM user_fruits WHERE plot_id=%s AND harvested=FALSE", (plot['id'],))
        for fruit in current_fruits:
            effects = json.loads(fruit.get('weather_effects') or '[]')
            active_effects = [e for e in effects if (current_time - datetime.fromisoformat(e['applied_at'])).total_seconds() < 120]
            ids_to_apply = global_weather_ids - {e['weather_id'] for e in active_effects}
            for w_id in ids_to_apply:
                if random.random() < WEATHER_TYPES[w_id]['stick_rate']:
                    active_effects.append({'weather_id': w_id, 'applied_at': current_time.isoformat(), 'duration_seconds': 120})
            if json.dumps(active_effects) != fruit.get('weather_effects'):
                db_execute("UPDATE user_fruits SET weather_effects=%s WHERE id=%s", (json.dumps(active_effects), fruit['id']), commit=True)

def calculate_redistributed_weights(possible_fruits, steal_percentage, dual_pool_share, tri_pool_share):
    normal_fruit = next((p for p in possible_fruits if 'normal' in p['image_suffix'].lower()), None)
    if not normal_fruit:
        return [p['rarity_rate'] for p in possible_fruits]
    single_specials = [p for p in possible_fruits if p['image_suffix'].count('_') == 0 and 'normal' not in p['image_suffix'].lower()]
    dual_specials = [p for p in possible_fruits if p['image_suffix'].count('_') == 1]
    tri_specials = [p for p in possible_fruits if p['image_suffix'].count('_') == 2]
    amount_to_redistribute = normal_fruit['rarity_rate'] * steal_percentage
    new_normal_rate = normal_fruit['rarity_rate'] - amount_to_redistribute
    bonus_for_dual_pool = amount_to_redistribute * dual_pool_share
    bonus_for_tri_pool = amount_to_redistribute * tri_pool_share
    total_original_dual_rate = sum(p['rarity_rate'] for p in dual_specials)
    total_original_tri_rate = sum(p['rarity_rate'] for p in tri_specials)
    new_weights_map = {normal_fruit['id']: new_normal_rate}
    for fruit in single_specials:
        new_weights_map[fruit['id']] = fruit['rarity_rate']
    for fruit in dual_specials:
        share = (fruit['rarity_rate'] / total_original_dual_rate) if total_original_dual_rate > 0 else (1 / len(dual_specials))
        bonus = bonus_for_dual_pool * share
        new_weights_map[fruit['id']] = fruit['rarity_rate'] + bonus
    for fruit in tri_specials:
        share = (fruit['rarity_rate'] / total_original_tri_rate) if total_original_tri_rate > 0 else (1 / len(tri_specials))
        bonus = bonus_for_tri_pool * share
        new_weights_map[fruit['id']] = fruit['rarity_rate'] + bonus
    return [new_weights_map.get(p['id'], p['rarity_rate']) for p in possible_fruits]

def spawn_new_fruit(user_id, plot):
    plant_id = plot['plant_type_id']
    effects = json.loads(plot.get('fertilizer_applied_effect') or '{}')
    now = datetime.now()
    fruit_weight = round(random.uniform(0.5, 50.0), 1)
    size_boost_effect = effects.get('fruit_size_boost')
    if size_boost_effect and now < datetime.fromisoformat(size_boost_effect['expiry']):
        fruit_weight *= (1 + size_boost_effect['value'])
    possible = [ft for ft in FRUIT_TYPES.values() if ft['plant_type_id'] == plant_id]
    weights = []
    tri_color_effect = effects.get('tri_color_boost')
    dual_color_effect = effects.get('dual_color_boost')
    color_boost_effect = effects.get('fruit_color_boost')
    is_tri_active = tri_color_effect and now < datetime.fromisoformat(tri_color_effect['expiry'])
    is_dual_active = dual_color_effect and now < datetime.fromisoformat(dual_color_effect['expiry'])
    is_color_boost_active = color_boost_effect and now < datetime.fromisoformat(color_boost_effect['expiry'])
    if is_tri_active:
        weights = calculate_redistributed_weights(possible, 0.90, 0.20, 0.80)
    elif is_dual_active:
        weights = calculate_redistributed_weights(possible, 0.80, 0.80, 0.20)
    elif is_color_boost_active:
        normal_fruit = next((f for f in possible if 'normal' in f['image_suffix'].lower()), None)
        special_fruits = [f for f in possible if 'normal' not in f['image_suffix'].lower()]
        if normal_fruit and special_fruits:
            effect_value = color_boost_effect['value']
            amount_to_redistribute = normal_fruit['rarity_rate'] * effect_value
            new_normal_rate = normal_fruit['rarity_rate'] - amount_to_redistribute
            total_special_original_rate = sum(f['rarity_rate'] for f in special_fruits)
            new_weights_map = {normal_fruit['id']: new_normal_rate}
            for fruit in special_fruits:
                bonus = (amount_to_redistribute * (fruit['rarity_rate'] / total_special_original_rate)) if total_special_original_rate > 0 else 0
                new_weights_map[fruit['id']] = fruit['rarity_rate'] + bonus
            weights = [new_weights_map.get(p['id'], p['rarity_rate']) for p in possible]
        else:
            weights = [ft['rarity_rate'] for ft in possible]
    else:
        weights = [ft['rarity_rate'] for ft in possible]
    if not weights or sum(w for w in weights if w is not None) <= 0:
        print(f"Error: Could not determine valid weights for plant_id {plant_id}. Aborting fruit spawn.")
        return
    chosen = random.choices(possible, weights=weights, k=1)[0]
    db_execute("INSERT INTO user_fruits(user_id,plot_id,fruit_type_id,weight,created_at) VALUES(%s,%s,%s,%s,%s)", (user_id, plot['id'], chosen['id'], round(fruit_weight, 1), now), commit=True)
    db_execute("UPDATE user_plots SET last_spawn_attempt_at = %s WHERE id = %s", (now, plot['id']), commit=True)
    print(f"Spawned a {chosen['color_name']} fruit for user {user_id} on plot {plot['plot_number']} at {now.strftime('%H:%M:%S')}")

@app.route('/api/harvest_fruit', methods=['POST'])
def harvest_fruit():
    user_id = session['user_id']
    fruit_id = request.json.get('fruit_id')
    query = '''
        SELECT uf.id as fruit_id, p.id as plot_id, pt.harvest_type
        FROM user_fruits uf
        JOIN user_plots p ON uf.plot_id = p.id
        JOIN plant_types pt ON p.plant_type_id = pt.id
        WHERE uf.id=%s AND uf.user_id=%s AND uf.harvested=FALSE AND uf.plot_id IS NOT NULL
    '''
    fruit_data = db_fetch_one(query, (fruit_id, user_id))
    if not fruit_data:
        return jsonify(success=False, message='Fruit not found on plot or already harvested.'), 404
    db_execute("UPDATE user_fruits SET plot_id=NULL, last_weather_check=NULL WHERE id=%s", (fruit_data['fruit_id'],), commit=True)
    db_execute("UPDATE user_plots SET last_harvest_at=%s WHERE id=%s", (datetime.now(), fruit_data['plot_id']), commit=True)
    if fruit_data['harvest_type'] == 'single_harvest':
        _reset_plot(fruit_data['plot_id'])
        print(f"Single-harvest plot {fruit_data['plot_id']} has been reset after harvest.")
    return get_game_state()

@app.route('/api/sell_fruits', methods=['POST'])
def sell_fruits():
    user_id = session['user_id']
    fruit_ids_to_sell = request.json.get('fruit_ids')
    if not fruit_ids_to_sell or not isinstance(fruit_ids_to_sell, list):
        return jsonify(success=False, message='Invalid fruit list provided.'), 400
    total_earned = 0
    valid_sold_ids = []
    for fruit_id in fruit_ids_to_sell:
        fruit = db_fetch_one("SELECT * FROM user_fruits WHERE id=%s AND user_id=%s AND plot_id IS NULL AND harvested=FALSE", (fruit_id, user_id))
        if not fruit:
            continue
        fruit_type = FRUIT_TYPES.get(fruit['fruit_type_id'])
        if not fruit_type:
            continue
        plant_type = PLANT_TYPES.get(fruit_type['plant_type_id'])
        if not plant_type:
            continue
        weather_mult = 1.0
        effects = json.loads(fruit.get('weather_effects') or '[]')
        ids = sorted([e['weather_id'] for e in effects])
        if ids:
            if len(ids) == 1:
                weather_info = WEATHER_TYPES.get(ids[0])
                weather_mult = weather_info.get('price_multiplier', 1.0) if weather_info else 1.0
            else:
                combo = next((c for c in WEATHER_COMBINATIONS.values() if sorted(c['weather_type_ids']) == ids), None)
                weather_mult = combo['price_multiplier'] if combo else 1.0
        earned = round(plant_type['base_price'] * fruit['weight'] * fruit_type['price_multiplier'] * weather_mult)
        total_earned += earned
        valid_sold_ids.append(fruit_id)
    if total_earned > 0:
        db_execute("UPDATE users SET money = money + %s WHERE id=%s", (total_earned, user_id), commit=True)
        if valid_sold_ids:
            placeholders = ', '.join(['%s'] * len(valid_sold_ids))
            query = f"UPDATE user_fruits SET harvested=TRUE WHERE id IN ({placeholders})"
            db_execute(query, tuple(valid_sold_ids), commit=True)
    return get_game_state()

def _reset_plot(plot_id):
    db_execute('''
        UPDATE user_plots
        SET
            plant_type_id = NULL,
            growth_stage = 0,
            planted_at = NULL,
            last_growth_update = NULL,
            growth_boost_seconds = 0,
            last_spawn_attempt_at = NULL,
            last_harvest_at = NULL,
            fertilizer_applied_effect = NULL
        WHERE id = %s
    ''', (plot_id,), commit=True)

@app.route('/api/dig_up_plant', methods=['POST'])
def dig_up_plant():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify(success=False, message='Authentication Required'), 401
    data = request.json
    plot_id = data.get('plot_id')
    if not plot_id:
        return jsonify(success=False, message='Plot ID is required.'), 400
    plot = db_fetch_one("SELECT id, plant_type_id FROM user_plots WHERE id=%s AND user_id=%s", (plot_id, user_id))
    if not plot or not plot.get('plant_type_id'):
        return jsonify(success=False, message='Plot not found or is already empty.'), 400
    db_execute("DELETE FROM user_fruits WHERE plot_id = %s", (plot_id,), commit=True)
    _reset_plot(plot_id)
    print(f"User {user_id} successfully dug up plot {plot_id}.")
    return get_game_state()

@app.route('/api/buy_item', methods=['POST'])
def buy_item():
    user_id = session.get('user_id')
    data = request.json
    item_type, item_id = data.get('item_type'), int(data.get('item_id'))
    user = db_fetch_one("SELECT money FROM users WHERE id=%s", (user_id,))
    price = 0
    if item_type == 'seed':
        price = PLANT_TYPES.get(item_id, {}).get('seed_price')
    elif item_type == 'fertilizer':
        price = FERTILIZER_TYPES.get(item_id, {}).get('price')
    if not price or user['money'] < price:
        return jsonify(success=False, message="Cannot purchase"), 400
    db_execute("UPDATE users SET money=money-%s WHERE id=%s", (price, user_id), commit=True)
    existing = db_fetch_one("SELECT id, quantity FROM inventory WHERE user_id=%s AND item_type=%s AND item_id=%s", (user_id, item_type, item_id))
    if existing:
        db_execute("UPDATE inventory SET quantity=quantity+1 WHERE id=%s", (existing['id'],), commit=True)
    else:
        db_execute("INSERT INTO inventory(user_id,item_type,item_id) VALUES(%s,%s,%s)", (user_id, item_type, item_id), commit=True)
    return get_game_state()

@app.route('/api/buy_plot', methods=['POST'])
def buy_plot():
    user_id = session['user_id']
    plot_num = int(request.json['plot_number'])
    cost = PLOT_COSTS.get(plot_num)
    if not cost:
        return jsonify(success=False, message="Invalid plot"), 400
    user = db_fetch_one("SELECT money FROM users WHERE id=%s", (user_id,))
    if user['money'] < cost:
        return jsonify(success=False, message="Not enough money"), 400
    if db_fetch_one("SELECT id FROM user_plots WHERE user_id=%s AND plot_number=%s", (user_id, plot_num)):
        return jsonify(success=False, message="Plot already owned"), 400
    db_execute("UPDATE users SET money=money-%s WHERE id=%s", (cost, user_id), commit=True)
    db_execute("INSERT INTO user_plots(user_id, plot_number) VALUES (%s,%s)", (user_id, plot_num), commit=True)
    return get_game_state()

@app.route('/api/plant_seed', methods=['POST'])
def plant_seed():
    user_id = session['user_id']
    data = request.json
    inv_id, plot_id = data.get('inventory_id'), data.get('plot_id')
    item = db_fetch_one("SELECT * FROM inventory WHERE id=%s AND user_id=%s AND item_type='seed'", (inv_id, user_id))
    if not item:
        return jsonify(success=False, message="Seed not found."), 400
    now = datetime.now()
    db_execute("UPDATE user_plots SET plant_type_id=%s,growth_stage=1,planted_at=%s,last_growth_update=%s, growth_boost_seconds=0, last_spawn_attempt_at=NULL WHERE id=%s", (item['item_id'], now, now, plot_id), commit=True)
    if item['quantity'] > 1:
        db_execute("UPDATE inventory SET quantity=quantity-1 WHERE id=%s", (inv_id,), commit=True)
    else:
        db_execute("DELETE FROM inventory WHERE id=%s", (inv_id,), commit=True)
    return get_game_state()

@app.route('/api/use_fertilizer', methods=['POST'])
def use_fertilizer():
    user_id = session['user_id']
    data = request.json
    inv_id, plot_id = data.get('inventory_id'), data.get('plot_id')
    item = db_fetch_one("SELECT * FROM inventory WHERE id=%s AND user_id=%s AND item_type='fertilizer'", (inv_id, user_id))
    if not item:
        return jsonify(success=False, message="Item not found"), 400
    plot = db_fetch_one("SELECT * FROM user_plots WHERE id=%s AND plant_type_id IS NOT NULL", (plot_id,))
    if not plot:
        return jsonify(success=False, message="No plant"), 400
    fert = FERTILIZER_TYPES[item['item_id']]
    effect_type = fert['effect_type']
    if effect_type == 'growth_boost':
        plant_type = PLANT_TYPES.get(plot['plant_type_id'])
        if not plant_type:
            return jsonify(success=False, message="Plant type not found for plot"), 500
        base_time_elapsed = (datetime.now() - plot['planted_at']).total_seconds()
        total_effective_time = base_time_elapsed + plot.get('growth_boost_seconds', 0)
        stage_duration_seconds = plant_type['growth_time_per_stage_seconds']
        time_in_current_stage = total_effective_time % stage_duration_seconds
        time_remaining_in_stage = stage_duration_seconds - time_in_current_stage
        boost_seconds_to_add = time_remaining_in_stage * fert['effect_value']
        db_execute("UPDATE user_plots SET growth_boost_seconds = growth_boost_seconds + %s WHERE id=%s", (boost_seconds_to_add, plot_id), commit=True)
    else:
        effects = json.loads(plot.get('fertilizer_applied_effect') or '{}')
        effects[effect_type] = {'expiry': (datetime.now() + timedelta(minutes=10)).isoformat(), 'value': fert['effect_value']}
        db_execute("UPDATE user_plots SET fertilizer_applied_effect=%s WHERE id=%s", (json.dumps(effects), plot_id), commit=True)
    if item['quantity'] > 1:
        db_execute("UPDATE inventory SET quantity=quantity-1 WHERE id=%s", (inv_id,), commit=True)
    else:
        db_execute("DELETE FROM inventory WHERE id=%s", (inv_id,), commit=True)
    return get_game_state()

if __name__ == '__main__':
    app.run(debug=True, port=5000, use_reloader=False)
