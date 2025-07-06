document.addEventListener('DOMContentLoaded', () => {
    const appContent = document.getElementById('app-content');
    let gameState = {};
    let gameLoopInterval = null;
    let uiUpdateInterval = null;

    function createDiv(id, className) {
        const d = document.createElement('div');
        if (id) d.id = id;
        if (className) d.className = className;
        return d;
    }

    function createButton(text, className, dataAttrs = {}) {
        const b = document.createElement('button');
        b.textContent = text;
        b.className = className;
        for (const k in dataAttrs) b.dataset[k] = dataAttrs[k];
        return b;
    }

    function formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return "--:--";
        seconds = Math.floor(seconds);
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        if (hours > 0) return `${String(hours)}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function generateFertilizerDescription(item) {
        const value = item.effect_value * 100;
        switch (item.effect_type) {
            case 'growth_boost':
                return `Immediately advances growth time based on the remaining time in the current stage by ${value}%.`;
            case 'fruit_size_boost':
                return `Increases new fruit size by ${value}% for 10 mins.`;
            case 'fruit_color_boost':
                return `Dramatically boosts the chance for any special color fruits for 10 mins.`;
            case 'dual_color_boost':
                return `Massively increases the chance of getting 2-color fruits for 10 mins.`;
            case 'tri_color_boost':
                return `Massively increases the chance of getting 3-color fruits for 10 mins.`;
            default:
                return "A mysterious fertilizer.";
        }
    }

    async function loadGameDashboard() {
        try {
            appContent.innerHTML = await (await fetch('/ui/game_dashboard')).text();
            await handleApiCall('/api/get_game_state', {});
            attachGameDashboardListeners();
            startGameLoop();
            startUiUpdateLoop();
        } catch (e) {
            console.error("Dashboard Load Error:", e);
        }
    }

    async function handleApiCall(url, options = {}, successCallback) {
        try {
            const response = await fetch(url, options);
            if (response.status === 401) {
                stopGameLoop();
                stopUiUpdateLoop();
                showAuthForm();
                return;
            }
            const result = await response.json();
            if (result.success) {
                if (result.state) {
                    gameState = result.state;
                    renderGameUI();
                }
                if (successCallback) successCallback(result);
            } else {
                alert(`Error: ${result.message || 'Unknown error'}`);
            }
        } catch (err) {
            console.error(`API Call failed for ${url}:`, err);
        }
    }

    async function handleLogout() {
        stopGameLoop();
        stopUiUpdateLoop();
        try {
            const response = await fetch('/api/logout');
            const result = await response.json();
            if (result.success) {
                gameState = {};
                showAuthForm(true);
            } else {
                alert('Logout failed. Please try again.');
            }
        } catch (error) {
            console.error("Logout Error:", error);
            alert('An error occurred during logout.');
        }
    }

    function renderGameUI() {
        if (!gameState || !gameState.user) return;
        document.getElementById('username-display').textContent = gameState.user.username;
        document.getElementById('user-money').textContent = gameState.user.money.toLocaleString();
        document.getElementById('global-weather').textContent = gameState.global_weather.map(w => w.name).join(', ') || 'Clear';
        renderPlots();
    }

    function renderPlots() {
        const plotsContainer = document.getElementById('plots-container');
        if (!plotsContainer) return;

        for (let i = 1; i <= 4; i++) {
            if (!document.getElementById(`plot-${i}`)) {
                const plotDiv = createDiv(`plot-${i}`);
                plotsContainer.appendChild(plotDiv);
            }
        }

        for (let i = 1; i <= 4; i++) {
            const plotDiv = document.getElementById(`plot-${i}`);
            const plotData = gameState.plots.find(p => p.plot_number === i);
            if (plotData) {
                if (plotData.plant_type_id) {
                    renderPlantedPlot(plotDiv, plotData);
                } else {
                    renderEmptyPlot(plotDiv, plotData);
                }
            }
            else {
                renderLockedPlot(plotDiv, i);
            }
        }
    }

    function handleDashboardClick(e) {
        const target = e.target;
        const classList = target.classList;

        if (target.id === 'logout-btn') handleLogout();
        else if (target.id === 'shop-btn') showShopModal();
        else if (target.id === 'inventory-btn') showInventoryModal();
        else if (classList.contains('buy-plot-btn')) handleBuyPlot(target.dataset.plotNumber);
        else if (classList.contains('use-fertilizer-btn')) showFertilizerModal(target.dataset.plotId);
        else if (classList.contains('dig-up-plant-btn')) {
            handleDigUpPlant(target.dataset.plotId, target.dataset.plantName);
        }
        else if (target.closest('.close-modal-btn')) closeAllModals();
        else if (classList.contains('plant-seed-btn')) showPlantSeedModal(target.dataset.plotId);
        else if (target.closest('.fruit-image')) handleHarvest(target.dataset.fruitId, target.closest('.fruit-container'));
    }

    function attachGameDashboardListeners() {
        document.body.removeEventListener('click', handleDashboardClick);
        document.body.addEventListener('click', handleDashboardClick);
    }

    async function handleHarvest(fruitId, container) {
        if (!container) return;
        container.style.transition = 'transform 0.3s, opacity 0.3s';
        container.style.transform = 'scale(0)';
        container.style.opacity = '0';

        handleApiCall('/api/harvest_fruit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fruit_id: fruitId
            })
        });
    }

    function handleDigUpPlant(plotId, plantName) {
        const confirmMessage = `Are you sure you want to dig up the ${plantName}?\n\nThis will permanently remove the plant and any fruits on it. This action cannot be undone.`;

        if (confirm(confirmMessage)) {
            handleApiCall('/api/dig_up_plant', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    plot_id: plotId
                })
            });
        }
    }

    function renderPlantedPlot(plotDiv, plot) {
        plotDiv.className = 'plot-area';
        const plantInfo = gameState.game_data.plant_types[plot.plant_type_id];

        if (plantInfo.harvest_type === 'single_harvest') {
            plotDiv.classList.add('single-harvest');

            if (plot.fruits.length > 0) {
                plotDiv.classList.add('ready-to-harvest');
                let infoDiv = plotDiv.querySelector('.plot-info');
                if (!infoDiv) {
                    plotDiv.innerHTML = '';
                    infoDiv = createDiv(null, 'plot-info');
                    plotDiv.appendChild(infoDiv);
                }
                infoDiv.innerHTML = `<h4 class="mature-text">Ready to Harvest!</h4>`;

                let plantImage = plotDiv.querySelector('.plant-image');
                if (plantImage) plantImage.remove();

                plotDiv.querySelectorAll('.fruit-container').forEach(c => c.remove());
                plot.fruits.forEach(fruit => {
                    const container = createFruitElement(fruit, plantInfo);
                    plotDiv.appendChild(container);
                    updateFruitElement(container, fruit, plantInfo);
                    updateWeatherIcon(container, fruit);
                });

                if (plotDiv.querySelector('.use-fertilizer-btn')) plotDiv.querySelector('.use-fertilizer-btn').remove();

            } else {
                plotDiv.classList.remove('ready-to-harvest');
                let infoDiv = plotDiv.querySelector('.plot-info');
                if (!infoDiv) {
                    plotDiv.innerHTML = '';
                    infoDiv = createDiv(null, 'plot-info');
                    plotDiv.appendChild(infoDiv);
                }
                const countdownHtml = `<p class="growth-countdown" data-plot-id="${plot.id}"></p>`;
                infoDiv.innerHTML = `
                    <h4>${plantInfo.name}</h4>
                    <p>Stage: ${plot.growth_stage} / ${plantInfo.max_growth_stage}</p>
                    ${countdownHtml}
                    <div class="plot-effects-container"></div>
                `;

                const imagePath = `/static/images/plants/${plantInfo.image_prefix}_${String(plot.growth_stage).padStart(2, '0')}.png`;
                let plantImage = plotDiv.querySelector('.plant-image');
                if (!plantImage) {
                    plantImage = document.createElement('img');
                    plantImage.className = 'plant-image';
                    plotDiv.appendChild(plantImage);
                }
                if (plantImage.src !== new URL(imagePath, window.location.origin).href) {
                    plantImage.src = imagePath;
                }

                plotDiv.querySelectorAll('.fruit-container').forEach(c => c.remove());

                if (!plotDiv.querySelector('.use-fertilizer-btn')) {
                    plotDiv.appendChild(createButton('Use Fertilizer', 'plot-button use-fertilizer-btn', {
                        plotId: plot.id
                    }));
                }
            }

            if (!plotDiv.querySelector('.dig-up-plant-btn')) {
                plotDiv.appendChild(createButton('Dig Up', 'plot-button dig-up-plant-btn', {
                    plotId: plot.id,
                    plantName: plantInfo.name
                }));
            }

        } else {
            const imagePath = `/static/images/plants/${plantInfo.image_prefix}_${String(plot.growth_stage).padStart(2, '0')}.png`;
            let infoDiv = plotDiv.querySelector('.plot-info');
            if (!infoDiv) {
                plotDiv.innerHTML = '';
                infoDiv = createDiv(null, 'plot-info');
                plotDiv.appendChild(infoDiv);
            }
            const countdownHtml = plot.growth_stage >= 20 ?
                `<p class="growth-countdown mature-text">Mature</p>` : `<p class="growth-countdown" data-plot-id="${plot.id}"></p>`;
            infoDiv.innerHTML = `
                <h4>${plantInfo.name}</h4>
                <p>Stage: ${plot.growth_stage} / 20</p>
                ${countdownHtml}
                <div class="plot-effects-container"></div>
            `;
            let plantImage = plotDiv.querySelector('.plant-image');
            if (!plantImage) {
                plantImage = document.createElement('img');
                plantImage.className = 'plant-image';
                plotDiv.appendChild(plantImage);
            }
            if (plantImage.src !== new URL(imagePath, window.location.origin).href) {
                plantImage.src = imagePath;
            }
            const serverFruitIds = new Set(plot.fruits.map(f => String(f.id)));
            plotDiv.querySelectorAll('.fruit-container').forEach(c => {
                if (!serverFruitIds.has(c.dataset.fruitId)) c.remove();
            });
            plot.fruits.forEach(fruit => {
                let container = plotDiv.querySelector(`.fruit-container[data-fruit-id="${fruit.id}"]`);
                if (!container) {
                    container = createFruitElement(fruit, plantInfo);
                    plotDiv.appendChild(container);
                }
                updateFruitElement(container, fruit, plantInfo);
                updateWeatherIcon(container, fruit);
            });
            if (!plotDiv.querySelector('.use-fertilizer-btn')) {
                plotDiv.appendChild(createButton('Use Fertilizer', 'plot-button use-fertilizer-btn', {
                    plotId: plot.id
                }));
            }
            if (!plotDiv.querySelector('.dig-up-plant-btn')) {
                plotDiv.appendChild(createButton('Dig Up', 'plot-button dig-up-plant-btn', {
                    plotId: plot.id,
                    plantName: plantInfo.name
                }));
            }
        }
    }

    function renderEmptyPlot(plotDiv, plot) {
        plotDiv.className = 'plot-area';
        if (plotDiv.innerHTML === '' || !plotDiv.querySelector('.plant-seed-btn')) {
            plotDiv.innerHTML = '';
            plotDiv.appendChild(createButton('Plant Seed', 'plot-button plant-seed-btn', {
                plotId: plot.id
            }));
        }
    }

    function renderLockedPlot(plotDiv, plotNumber) {
        plotDiv.className = 'plot-area locked';
        const ownedPlotsCount = gameState.plots.length;
        const shouldHaveButton = (plotNumber === ownedPlotsCount + 1);
        let button = plotDiv.querySelector('.buy-plot-btn');
        if (shouldHaveButton && !button) {
            const cost = gameState.game_data.plot_costs[plotNumber];
            plotDiv.innerHTML = `<span>Locked<br><small>Cost: 💰${cost.toLocaleString()}</small></span>`;
            plotDiv.appendChild(createButton('Buy Plot', 'plot-button buy-plot-btn', {
                plotNumber
            }));
        } else if (!shouldHaveButton) {
            plotDiv.innerHTML = `<span>Locked</span>`;
        }
    }

    const usedPositions = new Map();

    function createFruitElement(fruit, plantInfo) {
        const fruitInfo = gameState.game_data.fruit_types[fruit.fruit_type_id];
        const container = createDiv(null, 'fruit-container');
        container.dataset.fruitId = fruit.id;

        if (plantInfo.harvest_type === 'single_harvest') {
            container.classList.add('single-harvest-fruit');
        } else {
            const plantId = fruit.plant_id || plantInfo.id || 'default';

            if (!usedPositions.has(plantId)) {
                usedPositions.set(plantId, []);
            }

            const positions = usedPositions.get(plantId);
            let topPosition, leftPosition;
            let attempts = 0;
            const maxAttempts = 50;
            const minDistance = 15;

            do {
                if (plantInfo.name === 'Mango') {
                    topPosition = Math.random() * 40 + 15;
                    leftPosition = Math.random() * 40 + 20;
                } else if (plantInfo.name === 'Coconut') {
                    topPosition = Math.random() * 20 + 10;
                    leftPosition = Math.random() * 40 + 20;
                } else if (plantInfo.name === 'Banana') {
                    topPosition = Math.random() * 20 + 20;
                    leftPosition = Math.random() * 40 + 20;
                } else {
                    topPosition = Math.random() * 40 + 20;
                    leftPosition = Math.random() * 70 + 15;
                }
                attempts++;
            } while (attempts < maxAttempts && isPositionTooClose(topPosition, leftPosition, positions, minDistance));

            positions.push({
                top: topPosition,
                left: leftPosition
            });
            container.style.cssText = `position: absolute; top: ${topPosition}%; left: ${leftPosition}%;`;
        }

        const img = document.createElement('img');
        img.className = 'fruit-image';
        img.src = `/static/images/fruits/${plantInfo.image_prefix}_${fruitInfo.image_suffix}.png`;
        img.dataset.fruitId = fruit.id;
        container.appendChild(img);
        return container;
    }

    function isPositionTooClose(newTop, newLeft, existingPositions, minDistance) {
        return existingPositions.some(pos => {
            const distance = Math.sqrt(
                Math.pow(newTop - pos.top, 2) + Math.pow(newLeft - pos.left, 2)
            );
            return distance < minDistance;
        });
    }

    function clearUsedPositions(plantId = null) {
        if (plantId) {
            usedPositions.delete(plantId);
        } else {
            usedPositions.clear();
        }
    }

    function updateFruitElement(container, fruit, plantInfo) {
        const img = container.querySelector('.fruit-image');

        if (img) {
            const baseWeight = 25.0;
            const weightRatio = Math.sqrt(fruit.weight / baseWeight);

            let scaleMultiplier;

            if (plantInfo.harvest_type === 'single_harvest') {
                const baseScale = 1.2; 
                scaleMultiplier = baseScale * weightRatio;

                scaleMultiplier = Math.max(1.5, Math.min(scaleMultiplier, 4.5));

                container.style.transform = 'translateX(-50%)';
                img.style.transform = `scale(${scaleMultiplier.toFixed(2)})`;
            } else {
                const baseScale = 0.6; 
                scaleMultiplier = baseScale * weightRatio;

                scaleMultiplier = Math.max(1.0, Math.min(scaleMultiplier, 3.0));

                img.style.transform = `scale(${scaleMultiplier.toFixed(2)})`;
            }
        }
    }

    function updateWeatherIcon(container, fruit) {
        let existingIcon = container.querySelector('.weather-icon');
        const effects = fruit.weather_effects ? JSON.parse(fruit.weather_effects) : [];
        if (effects.length > 0) {
            let iconSrc = '';
            const ids = effects.map(e => e.weather_id).sort();
            if (ids.length === 1) {
                const weatherInfo = gameState.game_data.weather_types[ids[0]];
                if (weatherInfo) iconSrc = weatherInfo.display_icon_filename;
            } else {
                const combo = Object.values(gameState.game_data.weather_combinations).find(c => JSON.stringify(c.weather_type_ids.sort()) === JSON.stringify(ids));
                if (combo) iconSrc = combo.display_icon_filename;
            }
            if (iconSrc) {
                const fullIconPath = new URL(`/static/images/weather/${iconSrc}`, window.location.origin).href;
                if (!existingIcon) {
                    existingIcon = document.createElement('img');
                    existingIcon.className = 'weather-icon';
                    container.appendChild(existingIcon);
                }
                if (existingIcon.src !== fullIconPath) existingIcon.src = fullIconPath;
            }
        } else if (existingIcon) {
            existingIcon.remove();
        }
    }

    function updateAllTimers() {
        if (!gameState.game_data) return;
        const now = new Date();
        updateTopBarCountdowns(now);
        updateAllPlotInfo(now);
    }

    function updateTopBarCountdowns(now) {
        const fruitEl = document.getElementById('fruit-countdown');
        const weatherEl = document.getElementById('weather-countdown');
        if (!fruitEl || !weatherEl) return;

        const currentMinute = now.getMinutes();
        let nextFruitMinute = (currentMinute % 2 === 0) ? currentMinute + 2 : currentMinute + 1;
        const nextFruitTime = new Date(now);
        nextFruitTime.setMinutes(nextFruitMinute, 0, 0);
        const fruitSecondsLeft = (nextFruitTime - now) / 1000;
        fruitEl.textContent = formatTime(fruitSecondsLeft);

        let nextWeatherMinute = Math.ceil((currentMinute + 0.01) / 5) * 5;
        const nextWeatherTime = new Date(now);
        if (nextWeatherMinute >= 60) {
            nextWeatherTime.setHours(now.getHours() + 1, 0, 0, 0);
        } else {
            nextWeatherTime.setMinutes(nextWeatherMinute, 0, 0);
        }
        const weatherSecondsLeft = (nextWeatherTime - now) / 1000;
        weatherEl.textContent = formatTime(weatherSecondsLeft);
    }

    function updatePlotCountdowns(now) {
        document.querySelectorAll('.growth-countdown').forEach(el => {
            if (el.classList.contains('mature-text')) return;

            const plotId = parseInt(el.dataset.plotId, 10);
            const plot = gameState.plots.find(p => p.id === plotId);

            if (!plot || !plot.plant_type_id || plot.growth_stage >= 20) {
                el.textContent = "";
                return;
            }

            const plantInfo = gameState.game_data.plant_types[plot.plant_type_id];
            const plantedAt = new Date(plot.planted_at);

            if (isNaN(plantedAt.getTime())) {
                el.textContent = "Next Stage: Error";
                return;
            }

            const baseElapsedMs = now.getTime() - plantedAt.getTime();
            const boostMs = (plot.growth_boost_seconds || 0) * 1000;
            const totalEffectiveElapsedMs = baseElapsedMs + boostMs;

            const stageDurationMs = plantInfo.growth_time_per_stage_seconds * 1000;
            const calculatedStage = Math.floor(totalEffectiveElapsedMs / stageDurationMs) + 1;
            const currentStage = Math.min(20, calculatedStage);

            if (currentStage !== plot.growth_stage) {
                const timeToNextStageMs = ((currentStage) * stageDurationMs) - totalEffectiveElapsedMs;
                const secondsLeft = Math.max(0, timeToNextStageMs / 1000);
                el.textContent = `Next Stage: ${formatTime(secondsLeft)}`;
            } else {
                const timeInCurrentStageMs = totalEffectiveElapsedMs % stageDurationMs;
                const remainingMs = stageDurationMs - timeInCurrentStageMs;
                const secondsLeft = remainingMs / 1000;

                if (el.textContent !== `Next Stage: ${formatTime(secondsLeft)}`) {
                    el.textContent = `Next Stage: ${formatTime(secondsLeft)}`;
                }
            }
        });
    }

    function updateAllPlotInfo(now) {
        updatePlotCountdowns(now);

        const EFFECT_DISPLAY_NAMES = {
            fruit_size_boost: 'Size Boost',
            fruit_color_boost: 'Color Boost',
            dual_color_boost: 'Dual-Color',
            tri_color_boost: 'Tri-Color'
        };

        gameState.plots.forEach(plot => {
            if (!plot.plant_type_id) return;

            const plotDiv = document.querySelector(`#plot-${plot.plot_number}`);
            if (!plotDiv) return;
            const container = plotDiv.querySelector('.plot-effects-container');
            if (!container) return;

            const effects = plot.fertilizer_applied_effect ? JSON.parse(plot.fertilizer_applied_effect) : {};
            const activeEffectTypes = [];

            for (const effectType in effects) {
                const effect = effects[effectType];
                const expiryTime = new Date(effect.expiry);
                const secondsLeft = (expiryTime - now) / 1000;

                if (secondsLeft > 0) {
                    activeEffectTypes.push(effectType);
                    const displayName = EFFECT_DISPLAY_NAMES[effectType] || effectType;

                    let effectEl = container.querySelector(`[data-effect-type="${effectType}"]`);
                    if (!effectEl) {
                        effectEl = createDiv(null, 'effect-countdown');
                        effectEl.dataset.effectType = effectType;
                        container.appendChild(effectEl);
                    }

                    effectEl.textContent = `${displayName}: ${formatTime(secondsLeft)}`;
                }
            }

            container.querySelectorAll('.effect-countdown').forEach(el => {
                if (!activeEffectTypes.includes(el.dataset.effectType)) {
                    el.remove();
                }
            });
        });
    }

    function handleBuyPlot(plotNum) {
        const cost = gameState.game_data.plot_costs[plotNum];
        if (confirm(`Buy Plot ${plotNum} for 💰${cost.toLocaleString()}?`)) {
            handleApiCall('/api/buy_plot', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    plot_number: plotNum
                })
            });
        }
    }

    function showModal(title, body) {
        closeAllModals();
        const modal = createDiv(null, 'modal-backdrop');
        modal.innerHTML = `<div class="modal"><div class="modal-header"><h2>${title}</h2><button class="close-modal-btn">×</button></div><div class="modal-body">${body}</div></div>`;
        document.body.appendChild(modal);
    }

    function closeAllModals() {
        document.querySelectorAll('.modal-backdrop').forEach(m => m.remove());
    }

    function showShopModal() {
        const shopTitle = `<img src="/static/images/icon/cart.png" class="modal-title-icon" alt="Shop"> Shop`;
        showModal(shopTitle, `<h3>Seeds</h3><div id="seed-items" class="shop-grid"></div><hr><h3>Fertilizers</h3><div id="fert-items" class="shop-grid"></div>`);

        const inventoryMap = {};
        gameState.inventory.forEach(invItem => {
            inventoryMap[`${invItem.item_type}-${invItem.item_id}`] = invItem.quantity;
        });

        const groups = [{
            containerId: 'seed-items',
            itemType: 'seed',
            data: gameState.game_data.plant_types
        }, {
            containerId: 'fert-items',
            itemType: 'fertilizer',
            data: gameState.game_data.fertilizer_types
        }];

        groups.forEach(group => {
            const container = document.getElementById(group.containerId);
            Object.values(group.data)
                .sort((a, b) => (a.seed_price ?? a.price) - (b.seed_price ?? b.price))
                .forEach(item => {
                    const el = createDiv(null, 'shop-item');
                    el.dataset.itemKey = `${group.itemType}-${item.id}`;
                    const price = item.seed_price ?? item.price;
                    const ownedQuantity = inventoryMap[`${group.itemType}-${item.id}`] || 0;
                    let imageUrl = '';
                    if (group.itemType === 'seed') imageUrl = `/static/images/fruits/${item.image_prefix}_normal.png`;
                    else if (group.itemType === 'fertilizer') imageUrl = `/static/images/fertilizer/${item.name.replace(/ /g, '_') + '.png'}`;

                    let descriptionHtml = (group.itemType === 'fertilizer') ? `<p class="item-description">${generateFertilizerDescription(item)}</p>` : '';
                    el.innerHTML = `
                        <img src="${imageUrl}" alt="${item.name}" style="width: 60px; height: 60px; object-fit: contain;">
                        <h4>${item.name}</h4>
                        ${descriptionHtml}
                        <p class="owned-count">Owned: ${ownedQuantity}</p>
                        <div class="price">💰 ${price.toLocaleString()}</div>`;
                    el.appendChild(createButton('Buy', 'buy-btn', {
                        itemType: group.itemType,
                        itemId: item.id
                    }));
                    container.appendChild(el);
                });
        });

        const modalBody = document.querySelector('.modal-body');
        if (modalBody) {
            modalBody.addEventListener('click', e => {
                if (e.target.classList.contains('buy-btn')) {
                    const {
                        itemType,
                        itemId
                    } = e.target.dataset;
                    const currentScrollTop = modalBody.scrollTop;
                    handleApiCall('/api/buy_item', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            item_type: itemType,
                            item_id: itemId
                        })
                    }, (result) => {
                        if (result.success) {
                            const newInventoryMap = {};
                            gameState.inventory.forEach(invItem => newInventoryMap[`${invItem.item_type}-${invItem.item_id}`] = invItem.quantity);
                            document.querySelectorAll('.shop-item').forEach(shopItem => {
                                const itemKey = shopItem.dataset.itemKey;
                                const ownedCountEl = shopItem.querySelector('.owned-count');
                                if (ownedCountEl) {
                                    ownedCountEl.textContent = `Owned: ${newInventoryMap[itemKey] || 0}`;
                                }
                            });
                            modalBody.scrollTop = currentScrollTop;
                        }
                    });
                }
            });
        }
    }

    function showInventoryModal() {
        const inventoryTitle = `<img src="/static/images/icon/backpack.png" class="modal-title-icon" alt="Inventory"> Inventory`;

        const createItemHtml = (item, type) => {
            let info, imageUrl, descriptionHtml = '';
            if (type === 'seed') {
                info = gameState.game_data.plant_types[item.item_id];
                if (info) imageUrl = `/static/images/fruits/${info.image_prefix}_normal.png`;
            } else if (type === 'fertilizer') {
                info = gameState.game_data.fertilizer_types[item.item_id];
                if (info) {
                    const imageName = info.name.replace(/ /g, '_') + '.png';
                    imageUrl = `/static/images/fertilizer/${imageName}`;
                    descriptionHtml = `<p class="item-description">${generateFertilizerDescription(info)}</p>`;
                }
            }
            if (!info) return '';
            return `
                <div class="shop-item">
                    <img src="${imageUrl}" alt="${info.name}" style="width: 60px; height: 60px; object-fit: contain;">
                    <h4>${info.name}</h4>
                    ${descriptionHtml}
                    <p>Quantity: ${item.quantity.toLocaleString()}</p>
                </div>`;
        };

        const calculateFruitPrice = (fruit) => {
            const fruitType = gameState.game_data.fruit_types[fruit.fruit_type_id];
            const plantType = gameState.game_data.plant_types[fruitType.plant_type_id];

            let weatherMult = 1.0;
            const effects = fruit.weather_effects ? JSON.parse(fruit.weather_effects) : [];
            const ids = effects.map(e => e.weather_id).sort();

            if (ids.length > 0) {
                if (ids.length === 1) {
                    const weatherInfo = gameState.game_data.weather_types[ids[0]];
                    if (weatherInfo) weatherMult = weatherInfo.price_multiplier || 1.0;
                } else {
                    const combo = Object.values(gameState.game_data.weather_combinations).find(c => JSON.stringify(c.weather_type_ids.sort()) === JSON.stringify(ids));
                    if (combo) weatherMult = combo.price_multiplier || 1.0;
                }
            }
            return Math.round(plantType.base_price * fruit.weight * fruitType.price_multiplier * weatherMult);
        };

        const generateWeatherText = (fruit) => {
            const effects = fruit.weather_effects ? JSON.parse(fruit.weather_effects) : [];
            if (effects.length === 0) return '';

            const ids = effects.map(e => e.weather_id).sort();

            if (ids.length === 1) {
                const weatherInfo = gameState.game_data.weather_types[ids[0]];
                return weatherInfo ? weatherInfo.name : '';
            }

            if (ids.length > 1) {
                const combo = Object.values(gameState.game_data.weather_combinations)
                    .find(c => JSON.stringify(c.weather_type_ids.sort()) === JSON.stringify(ids));
                return combo ? combo.name : '';
            }

            return '';
        };

        let seedsHtml = '<h3>Seeds</h3><div class="shop-grid">';
        const seedItems = gameState.inventory.filter(i => i.item_type === 'seed');
        if (seedItems.length > 0) seedItems.forEach(item => seedsHtml += createItemHtml(item, 'seed'));
        else seedsHtml += '<p>No seeds.</p>';
        seedsHtml += '</div>';

        let fertsHtml = '<h3>Fertilizers</h3><div class="shop-grid">';
        const fertItems = gameState.inventory.filter(i => i.item_type === 'fertilizer');
        if (fertItems.length > 0) fertItems.forEach(item => fertsHtml += createItemHtml(item, 'fertilizer'));
        else fertsHtml += '<p>No fertilizers.</p>';
        fertsHtml += '</div>';

        let fruitsHtml = '<h3>Harvested Fruits</h3>';
        const fruitItems = gameState.inventory_fruits;
        let totalAllValue = 0;
        if (fruitItems && fruitItems.length > 0) {
            let fruitCardsHtml = '';
            fruitItems.forEach(fruit => {
                const price = calculateFruitPrice(fruit);
                totalAllValue += price;

                let weatherIconHtml = '';
                const effects = fruit.weather_effects ? JSON.parse(fruit.weather_effects) : [];
                if (effects.length > 0) {
                    let iconSrc = '';
                    const ids = effects.map(e => e.weather_id).sort();
                    if (ids.length === 1) {
                        const weatherInfo = gameState.game_data.weather_types[ids[0]];
                        if (weatherInfo) iconSrc = weatherInfo.display_icon_filename;
                    } else {
                        const combo = Object.values(gameState.game_data.weather_combinations).find(c => JSON.stringify(c.weather_type_ids.sort()) === JSON.stringify(ids));
                        if (combo) iconSrc = combo.display_icon_filename;
                    }
                    if (iconSrc) {
                        weatherIconHtml = `<img src="/static/images/weather/${iconSrc}" class="inventory-weather-icon" alt="Weather Effect">`;
                    }
                }

                const weatherText = generateWeatherText(fruit);
                const weatherTextHtml = weatherText ? `<p class="inventory-weather-text">${weatherText}</p>` : '';

                fruitCardsHtml += `
                    <div class="shop-item inventory-fruit-item">
                        <label class="fruit-select-label">
                            ${weatherIconHtml}
                            <input type="checkbox" class="fruit-select-checkbox" data-fruit-id="${fruit.id}" data-price="${price}">
                            <img src="/static/images/fruits/${fruit.image_prefix}_${fruit.image_suffix}.png" alt="${fruit.plant_name}" style="width:60px; height:60px; object-fit:contain;">
                        </label>
                        <h4>${fruit.color_name} ${fruit.plant_name}</h4>
                        ${weatherTextHtml}
                        <p>Weight: ${fruit.weight} kg</p>
                        <p class="price">Value: 💰${price.toLocaleString()}</p>
                    </div>`;
            });
            fruitsHtml += `
                <div class="inventory-actions">
                    <button id="sell-selected-btn">Sell Selected</button>
                    <button id="sell-all-btn">Sell All (💰${totalAllValue.toLocaleString()})</button>
                    <div id="total-selected-value">Selected Value: 💰0</div>
                </div>
                <div class="shop-grid fruit-inventory-container">${fruitCardsHtml}</div>`;
        } else {
            fruitsHtml += '<p>No harvested fruits.</p>';
        }

        showModal(inventoryTitle, `<div id="inventory-content">${fruitsHtml}<hr>${seedsHtml}<hr>${fertsHtml}</div>`);
        const modalBody = document.querySelector('.modal-body');
        if (modalBody) {
            modalBody.addEventListener('click', e => {
                if (e.target.id === 'sell-selected-btn') {
                    const selectedIds = Array.from(document.querySelectorAll('.fruit-select-checkbox:checked')).map(cb => parseInt(cb.dataset.fruitId));
                    if (selectedIds.length > 0) handleSellFruits(selectedIds);
                    else alert('Please select fruits to sell.');
                }
                if (e.target.id === 'sell-all-btn') {
                    const allIds = Array.from(document.querySelectorAll('.fruit-select-checkbox')).map(cb => parseInt(cb.dataset.fruitId));
                    if (allIds.length > 0) handleSellFruits(allIds, totalAllValue);
                    else alert('There are no fruits to sell.');
                }
            });
            modalBody.addEventListener('change', e => {
                if (e.target.classList.contains('fruit-select-checkbox')) {
                    let totalValue = 0;
                    document.querySelectorAll('.fruit-select-checkbox:checked').forEach(cb => {
                        totalValue += parseInt(cb.dataset.price);
                    });
                    document.getElementById('total-selected-value').textContent = `Selected Value: 💰${totalValue.toLocaleString()}`;
                }
            });
        }
    }

    function handleSellFruits(ids, totalValue = 0) {
        let confirmMessage = `Are you sure you want to sell ${ids.length} fruit(s)?`;
        if (totalValue > 0) {
            confirmMessage = `Are you sure you want to sell all ${ids.length} fruits for 💰${totalValue.toLocaleString()}?`;
        }

        if (confirm(confirmMessage)) {
            handleApiCall('/api/sell_fruits', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    fruit_ids: ids
                })
            }, (result) => {
                if (result.success) {
                    showInventoryModal();
                }
            });
        }
    }

    function createItemSelectionModal(title, items, infoLookup, buttonData, onSelect) {
        let body = items.length === 0 ? `<p>You have no ${buttonData.itemName}s!</p>` : '<div class="shop-grid">';

        if (items.length > 0) {
            items.forEach(item => {
                const info = infoLookup[item.item_id];
                let descriptionHtml = '';
                let imageUrl = '';

                if (info) {
                    if (buttonData.itemName === 'fertilizer') {
                        const imageName = info.name.replace(/ /g, '_') + '.png';
                        imageUrl = `/static/images/fertilizer/${imageName}`;
                        descriptionHtml = `<p class="item-description">${generateFertilizerDescription(info)}</p>`;
                    } else if (buttonData.itemName === 'seed') {
                        imageUrl = `/static/images/fruits/${info.image_prefix}_normal.png`;
                    }

                    body += `
                        <div class="shop-item">
                            <img src="${imageUrl}" alt="${info.name}" style="width: 60px; height: 60px; object-fit: contain;">
                            <h4>${info.name}</h4>
                            ${descriptionHtml}
                            <p>Owned: ${item.quantity}</p>
                            ${createButton(buttonData.text, buttonData.className, { inventoryId: item.id }).outerHTML}
                        </div>
                    `;
                }
            });
            body += '</div>';
        }

        showModal(title, body);
        document.querySelectorAll(`.${buttonData.className}`).forEach(btn => {
            btn.onclick = onSelect;
        });
    }

    function showPlantSeedModal(plotId) {
        const items = gameState.inventory.filter(i => i.item_type === 'seed');
        createItemSelectionModal('Choose a Seed', items, gameState.game_data.plant_types, {
            text: 'Plant This',
            className: 'select-seed-btn',
            itemName: 'seed'
        }, (e) => {
            closeAllModals();
            handleApiCall('/api/plant_seed', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    inventory_id: e.target.dataset.inventoryId,
                    plot_id: plotId
                })
            });
        });
    }

    function showFertilizerModal(plotId) {
        const items = gameState.inventory.filter(i => i.item_type === 'fertilizer');
        createItemSelectionModal('Use a Fertilizer', items, gameState.game_data.fertilizer_types, {
            text: 'Use This',
            className: 'select-fertilizer-btn',
            itemName: 'fertilizer'
        }, (e) => {
            closeAllModals();
            handleApiCall('/api/use_fertilizer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    inventory_id: e.target.dataset.inventoryId,
                    plot_id: plotId
                })
            });
        });
    }

    function startGameLoop() {
        if (gameLoopInterval) clearInterval(gameLoopInterval);
        gameLoopInterval = setInterval(updateGame, 5000);
    }

    function stopGameLoop() {
        if (gameLoopInterval) clearInterval(gameLoopInterval);
        gameLoopInterval = null;
    }

    function startUiUpdateLoop() {
        if (uiUpdateInterval) clearInterval(uiUpdateInterval);
        uiUpdateInterval = setInterval(updateAllTimers, 1000);
    }

    function stopUiUpdateLoop() {
        if (uiUpdateInterval) clearInterval(uiUpdateInterval);
        uiUpdateInterval = null;
    }
    async function updateGame() {
        if (document.hidden) return;
        await handleApiCall('/api/update_game', {});
    }
    async function initializeApp() {
        try {
            const r = await fetch('/api/check_session');
            const data = await r.json();
            if (data.logged_in) await loadGameDashboard();
            else showAuthForm();
        } catch (e) {
            console.error(e);
        }
    }

    async function showAuthForm(showLoginFirst = false) {
        try {
            appContent.innerHTML = await (await fetch('/ui/login_register')).text();

            if (showLoginFirst) {
                document.getElementById('register-form').style.display = 'none';
                document.getElementById('login-form').style.display = 'block';
            }

            attachAuthFormListeners();
        } catch (e) {
            console.error(e);
        }
    }

    function attachAuthFormListeners() {
        const loginForm = document.getElementById('login-form'),
            registerForm = document.getElementById('register-form');
        document.getElementById('show-login-link')?.addEventListener('click', e => {
            e.preventDefault();
            registerForm.style.display = 'none';
            loginForm.style.display = 'block';
        });
        document.getElementById('show-register-link')?.addEventListener('click', e => {
            e.preventDefault();
            loginForm.style.display = 'none';
            registerForm.style.display = 'block';
        });
        const handleAuth = (url, form) => handleApiCall(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: form.elements[0].value,
                password: form.elements[1].value
            })
        }, loadGameDashboard);
        registerForm?.addEventListener('submit', e => {
            e.preventDefault();
            handleAuth('/api/register', e.target);
        });
        loginForm?.addEventListener('submit', e => {
            e.preventDefault();
            handleAuth('/api/login', e.target);
        });
    }

    initializeApp();
});