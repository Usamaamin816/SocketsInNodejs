//first you have to create an instance of server that s enables CORS (Cross-Origin Resource Sharing) for the Socket.IO server, allowing it to accept connections from any origin (domain, protocol, or port). The * is a wildcard character that allows all origins.
//This sets the maximum size of the HTTP buffer for the Socket.IO server to 10MB (1e7 bytes). This buffer is used to store incoming HTTP requests before they are processed.
//By creating a new Socket.IO server instance and attaching it to the Express server, this code enables real-time communication between the server and connected clients (usually web browsers) using WebSockets.
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
	console.log(`Listening on port ${PORT}`);
	job.shopRefresh();
});

const io = new Server(server, {
	cors: { origin: "*" },
	maxHttpBufferSize: 1e7
});

//to write a custom logic to emit or listen calls we creare hooks that will allow to exceute our custom logic  here is the code 
io.on("connection", socket => {
  console.log("New client connected!");
  socket.emit("welcome", "Hello from the server!");
});

//now this i used to listen a socket call from client side to create an map 
io.on("connection", socket => {
  socketMapsDataStructure[socket.id] = {};

	const CREATE_MAP_SOCKET = "create-map-socket";
  const CANCEL_MAP_SOCKET = "cancel-map-socket";
	const GET_USER_LOCATION = "get-user-location";
	const UPDATE_MAP_LOCATION = "update-map-location";

  socket.on(GET_USER_LOCATION, data => {
		try {
			socketMapsDataStructure[data.socketID]["currentLocation"] = data.location;
			const nocRouteData = new NocRoute(data);
			nocRouteData.save();

			// Emit a success response
			socket.emit(GET_USER_LOCATION, {
				message: "Acknowledged",
				location: data.location
			});
		} catch (error) {
			console.error("Error processing GET_USER_LOCATION:", error);
			socket.emit(GET_USER_LOCATION, {
				message: "Error processing request",
				error: error.message
			});
		}
	});

  socket.on(CANCEL_MAP_SOCKET, data => {
		socketMapsDataStructure[data.socketID][data.mapID] = false;
	});
  socket.on(CREATE_MAP_SOCKET, data => {
		(async () => {
			let insertLocationData = [];
			let failedCount = 0;
			// console.log("listen");

			socketMapsDataStructure[data.socketID][data.mapID] = true;

			try {
				for (let index = 0; index < data.data.length; index++) {
					if (!socketMapsDataStructure[data.socketID]?.[data.mapID]) {
						socket.emit(CANCEL_MAP_SOCKET, {
							status: true,
							socketID: data.socketID,
							mapID: data.mapID,
							message: `Map cancelled successfully.`
						});
						await PinsLocations.insertMany(insertLocationData);
						return;
					}

					const item = data.data[index];
					let { address, city, state, zip } = item;

					// If city, state, or zip is not available, consider the name as the address
					if (!city && !state && !zip && !address) {
						address = item.name;
					}
					item.id = uuid();
					let pinFound = false;
					if (address && city && state && zip) {
						let locationMatched = await PinsLocations?.fuzzySearch(address, {
							$and: [{ zip: zip }, { state: state }, { city: city }]
						});
						console.log("locationMatched", locationMatched);

						item.id = uuid();

						if (locationMatched?.length > 0) {
							// console.log("locationMatched");
							let pinData = locationMatched[0];
							if (pinData && pinData?.confidenceScore >= 1) {
								pinFound = true;

								item.index = index;
								item.location = pinData?.location;
								item.g_city = pinData?.g_city?.trim();
								item.g_zip = pinData?.g_zip?.trim();
								item.g_state = pinData?.g_state?.trim();
								item.g_country = pinData?.g_country?.trim();
								item.g_timezone = pinData?.g_timezone;
							}
						}
					}

					if (!pinFound) {
						let geoItem =
							!city && !state && !zip && !address ? { address: address } : item;
						let { data } = await Geolocation(geoItem); // Pass only address if city, state, or zip is not available
						console.log("running");
						// console.log("data>>", data);
						// console.log("index", index);
						// console.log("data.results[0].geometry?.location", data.results[0]);
						if (data?.results?.length) {
							const location = data.results[0].geometry?.location;
							// console.log("inSocketLocation", location);
							if (location) {
								item.location = location;
								const offsetData = await handleTimeZone(location);
								if (offsetData?.rawOffset) {
									item.g_timezone = getTimezone(offsetData.rawOffset);
								} else {
									item.g_timezone = null;
								}
							} else {
								failedCount++;
								item.location = null;
								item.index = index;
							}

							const formatted_address = data.results[0]?.formatted_address?.split(
								","
							);
							// console.log("formatted_address", formatted_address);

							const len = formatted_address?.length;
							// Update the address field to use the provided address
							const joinedString = formatted_address.join(", ");
							// Split the joined string by comma and select the first part
							const selectedPart = joinedString.split(",")[0].trim();
							item.address = selectedPart;

							item.index = index;
							item.g_city = formatted_address[len - 3]?.trim();
							item.g_state = formatted_address[len - 2]?.split(" ")[1]?.trim();
							item.g_zip = formatted_address[len - 2]?.split(" ")[2]?.trim();
							item.g_country = formatted_address[len - 1]?.trim();

							insertLocationData = [...insertLocationData, item];
						} else {
							failedCount++;
							item.location = null;
							item.index = index;
						}
					}
					// console.log("insertLocationData", insertLocationData);

					if (index === data.data.length - 1) {
						socket.emit(CREATE_MAP_SOCKET, {
							completed: true,
							socketID: data.socketID,
							data: item,
							mapID: data.mapID,
							current: index + 1,
							total: data.data.length,
							failed: failedCount
						});

						await PinsLocations.insertMany(insertLocationData);
					} else {
						socket.emit(CREATE_MAP_SOCKET, {
							socketID: data.socketID,
							mapID: data.mapID,
							data: item,
							completed: false,
							current: index + 1,
							failed: failedCount,
							total: data.data.length
						});
					}
				}
			} catch (error) {
				console.log("CREATE MAP PIN ERROR: ", error);

				socket.emit(CREATE_MAP_SOCKET, {
					completed: true,
					socketID: socket.id,
					mapID: data.mapID,
					error: error
				});
			}
		})();
	});

  socket.on(UPDATE_MAP_LOCATION, data => {
		(async () => {
			let insertLocationData = [];
			let failedCount = 0;
			let updatedLocations = [];
			// console.log("listenUpdate", data);
			socketMapsDataStructure[data.socketID][data.mapID] = true;
			try {
				for (let index = 0; index < data.data.length; index++) {
					if (!socketMapsDataStructure[data.socketID]?.[data.mapID]) {
						socket.emit(CANCEL_MAP_SOCKET, {
							status: true,
							socketID: data.socketID,
							mapID: data.mapID,
							message: `Map cancelled successfully.`
						});
						await PinsLocations.insertMany(insertLocationData);
						return;
					}
					const item = data.data[index];
					// console.log("item", item);
					let { address, city, state, zip } = item.rowData;
					// If city, state, or zip is not available, consider the name as the address
					if (!city && !state && !zip && !address) {
						address = item.rowData.name;
					}
					// item.rowData.id = uuid();
					let pinFound = false;
					if (address && city && state && zip) {
						let locationMatched = await PinsLocations?.fuzzySearch(address, {
							$and: [{ zip: zip }, { state: state }, { city: city }]
						});

						// item.rowData.id = uuid();

						if (locationMatched?.length > 0) {
							// console.log("locationMatched");
							let pinData = locationMatched[0];
							if (pinData && pinData?.confidenceScore >= 1) {
								pinFound = true;

								item.rowData.index = index;
								item.rowData.location = pinData?.location;
								item.rowData.g_city = pinData?.g_city?.trim();
								item.rowData.g_zip = pinData?.g_zip?.trim();
								item.rowData.g_state = pinData?.g_state?.trim();
								item.rowData.g_country = pinData?.g_country?.trim();
								item.rowData.g_timezone = pinData?.g_timezone;
							}
						}
					}
					if (!pinFound) {
						let geoItem =
							!city && !state && !zip && !address
								? { address: address }
								: item.rowData;
						let { data } = await Geolocation(geoItem); // Pass only address if city, state, or zip is not available
						// console.log("running");
						// console.log("data>>", data);
						// console.log("index", index);
						// console.log("data.results[0].geometry?.location", data.results[0]);
						if (data?.results?.length) {
							const location = data.results[0].geometry?.location;
							// console.log("inSocketLocation", location);
							if (location) {
								item.rowData.location = location;
								const offsetData = await handleTimeZone(location);
								if (offsetData?.rawOffset) {
									item.rowData.g_timezone = getTimezone(offsetData.rawOffset);
								} else {
									item.rowData.g_timezone = null;
								}
							} else {
								failedCount++;
								item.rowData.location = null;
								item.rowData.index = index;
							}

							const formatted_address = data.results[0]?.formatted_address?.split(
								","
							);
							// console.log("formatted_address", formatted_address);

							const len = formatted_address?.length;
							// Update the address field to use the provided address
							const joinedString = formatted_address.join(", ");
							// Split the joined string by comma and select the first part
							const selectedPart = joinedString.split(",")[0].trim();
							item.rowData.address = selectedPart;

							item.rowData.index = index;
							item.rowData.g_city = formatted_address[len - 3]?.trim();
							item.rowData.g_state = formatted_address[len - 2]
								?.split(" ")[1]
								?.trim();
							item.rowData.g_zip = formatted_address[len - 2]
								?.split(" ")[2]
								?.trim();
							item.rowData.g_country = formatted_address[len - 1]?.trim();

							insertLocationData = [...insertLocationData, item.rowData];
							// updatedLocations.push({ ...item });
							// updatedLocations = [...data.data[index], item.rowData];
							// console.log("updatedLocations", updatedLocations);
						} else {
							failedCount++;
							item.rowData.location = null;
							item.rowData.index = index;
						}
					}
					// console.log("insertLocationData", insertLocationData);
					if (index === data.data.length - 1) {
						socket.emit(UPDATE_MAP_LOCATION, {
							completed: true,
							socketID: data.socketID,
							data: data.data,
							mapID: data.mapID,
							current: index + 1,
							total: data.data.length,
							failed: failedCount
						});

						await PinsLocations.insertMany(insertLocationData);
						// console.log("finalResponse", item.rowData);
					} else {
						socket.emit(UPDATE_MAP_LOCATION, {
							socketID: data.socketID,
							mapID: data.mapID,
							data: data.data,
							completed: false,
							current: index + 1,
							failed: failedCount,
							total: data.data.length
						});
					}
				}
			} catch (error) {
				console.log("CREATE MAP PIN ERROR: ", error);

				socket.emit(UPDATE_MAP_LOCATION, {
					completed: true,
					socketID: socket.id,
					mapID: data.mapID,
					error: error
				});
			}
		})();
	});
  	socket.on("disconnect", () => {
		console.log("SERVER: USER DISCONNECTED: ", socket.id);
		socketMapsDataStructure[socket.id] = {};
	});
})
