# Bengaluru Coverage Strategy

The JIVA canonical dataset is not a fixed whitelist of 4 demo hospitals.
The dataset covers any verified public facility within the Bengaluru Urban geography that is available via our sources (Bengaluru Urban Govt, BBMP, official websites).

## Geographic Spread
The current data ingestion covers:
- North: Hebbal (Baptist)
- East: HAL Airport / Indiranagar (Manipal)
- Central: Shivajinagar (Bowring), Malleshwaram (KC General)
- South: Jayanagar (General Hospital)

As the ingestion pipeline is run against a complete HTML scrape of the BBMP and Govt directories, it will natively expand to all wards across the city without code changes.
